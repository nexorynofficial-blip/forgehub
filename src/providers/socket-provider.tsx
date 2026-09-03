"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useQueryClient, type InfiniteData } from "@tanstack/react-query";

import { queryKeys } from "@/lib/query-keys";
import {
  SOCKET_EVENTS,
  type MessageDeletedEvent,
  type MessageNewEvent,
  type MessageReadEvent,
  type NotificationNewEvent,
  type PresenceEvent,
  type TypingEvent,
} from "@/lib/socket/events";
import { connectSocket, disconnectSocket, getSocket } from "@/lib/socket/socket-client";
import type { Message } from "@/lib/services/messaging-service";
import type { NotificationPage } from "@/lib/services/notification-service";
import { useAuth } from "@/providers/auth-provider";

/**
 * The realtime layer.
 *
 * One socket, one place that translates its events into cache updates. Two
 * rules shape everything below:
 *
 *  - **Update the smallest thing that changed.** A `message:new` touches one
 *    conversation's message list and the conversation list's ordering, and
 *    nothing else. `queryClient.clear()` appears nowhere here — that belongs
 *    to sign-out alone, and using it for a realtime event would throw away
 *    every unrelated screen's data on every incoming message.
 *  - **Never invent state.** Every payload below is the server's own
 *    projection; nothing is reconstructed client-side.
 */

interface SocketContextValue {
  isConnected: boolean;
  /** Users currently online, as far as the server has told us. */
  onlineUserIds: Set<string>;
  /** `conversationId → usernames currently typing`, excluding the viewer. */
  typingByConversation: Record<string, string[]>;
  joinConversation: (conversationId: string) => void;
  leaveConversation: (conversationId: string) => void;
  emitTyping: (conversationId: string, typing: boolean) => void;
}

const SocketContext = createContext<SocketContextValue | null>(null);

/** How long a typing indicator survives without a refresh frame. */
const TYPING_TIMEOUT_MS = 5_000;

export function SocketProvider({ children }: { children: ReactNode }) {
  const { isAuthenticated, user } = useAuth();
  const queryClient = useQueryClient();

  const [isConnected, setIsConnected] = useState(false);
  const [onlineUserIds, setOnlineUserIds] = useState<Set<string>>(new Set());
  const [typingByConversation, setTypingByConversation] = useState<
    Record<string, string[]>
  >({});

  /** Pending "stop typing" timers, so a dropped stop frame cannot wedge one on. */
  const typingTimers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});

  const viewerId = user?.id ?? null;

  useEffect(() => {
    if (!isAuthenticated) {
      // No state reset here: the previous run's cleanup already did it. That
      // is also the right place for it — signing out is exactly when the
      // cleanup fires, and doing it in an effect body would cascade renders.
      disconnectSocket();
      return;
    }

    const socket = connectSocket();
    const timers = typingTimers.current;

    const handleConnect = () => setIsConnected(true);
    const handleDisconnect = () => setIsConnected(false);

    /**
     * A new message.
     *
     * Prepended to that conversation's cached page — the list is ordered
     * newest-first — and guarded against duplicates by id, because the sender
     * receives their own `message:new` on top of the REST response that
     * already put the message there.
     */
    const handleMessageNew = ({ message }: MessageNewEvent) => {
      const typed = message as Message;

      queryClient.setQueryData<
        InfiniteData<{ items: Message[]; nextCursor: string | null }>
      >(queryKeys.messages(typed.conversationId), (data) => {
        if (!data || data.pages.length === 0) return data;
        const alreadyPresent = data.pages.some((page) =>
          page.items.some((item) => item.id === typed.id),
        );
        if (alreadyPresent) return data;

        const [firstPage, ...rest] = data.pages;
        return {
          ...data,
          pages: [{ ...firstPage, items: [typed, ...firstPage.items] }, ...rest],
        };
      });

      // The conversation list carries `lastMessage`, `unreadCount` and its own
      // ordering — all three move on a new message, and the server owns them.
      void queryClient.invalidateQueries({ queryKey: queryKeys.conversations });
    };

    const handleMessageDeleted = ({ id, conversationId }: MessageDeletedEvent) => {
      queryClient.setQueryData<
        InfiniteData<{ items: Message[]; nextCursor: string | null }>
      >(queryKeys.messages(conversationId), (data) =>
        data
          ? {
              ...data,
              pages: data.pages.map((page) => ({
                ...page,
                items: page.items.filter((item) => item.id !== id),
              })),
            }
          : data,
      );
      void queryClient.invalidateQueries({ queryKey: queryKeys.conversations });
    };

    /**
     * A moved read watermark — someone else's "seen", or this viewer's own
     * inbox clearing on another device. Either way the unread counts the
     * server keeps are now different, so they get refetched rather than
     * recomputed here.
     */
    const handleMessageRead = ({ conversationId }: MessageReadEvent) => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.conversations });
      void queryClient.invalidateQueries({
        queryKey: queryKeys.conversation(conversationId),
      });
    };

    const clearTyping = (conversationId: string, username: string) => {
      setTypingByConversation((prev) => {
        const current = prev[conversationId];
        if (!current) return prev;
        const next = current.filter((name) => name !== username);
        return next.length > 0
          ? { ...prev, [conversationId]: next }
          : Object.fromEntries(
              Object.entries(prev).filter(([key]) => key !== conversationId),
            );
      });
    };

    const handleTyping = ({ conversationId, userId, username }: TypingEvent) => {
      // The server relays with the *handshake* identity, so this is who it
      // says it is; the only thing left to filter is our own echo.
      if (userId === viewerId) return;

      setTypingByConversation((prev) => {
        const current = prev[conversationId] ?? [];
        if (current.includes(username)) return prev;
        return { ...prev, [conversationId]: [...current, username] };
      });

      const key = `${conversationId}:${username}`;
      clearTimeout(timers[key]);
      timers[key] = setTimeout(() => {
        clearTyping(conversationId, username);
      }, TYPING_TIMEOUT_MS);
    };

    const handleStopTyping = ({ conversationId, userId, username }: TypingEvent) => {
      if (userId === viewerId) return;
      const key = `${conversationId}:${username}`;
      clearTimeout(timers[key]);
      clearTyping(conversationId, username);
    };

    const handlePresence = ({ userId, online }: PresenceEvent) => {
      setOnlineUserIds((prev) => {
        const next = new Set(prev);
        if (online) next.add(userId);
        else next.delete(userId);
        return next;
      });
    };

    /**
     * A new notification.
     *
     * Prepended to the cached first page so the panel updates without a
     * refetch, and the unread badge is invalidated so its count comes from the
     * server rather than a local increment that could drift.
     */
    const handleNotificationNew = ({ notification }: NotificationNewEvent) => {
      queryClient.setQueryData<InfiniteData<NotificationPage>>(
        queryKeys.notifications,
        (data) => {
          if (!data || data.pages.length === 0) return data;
          const alreadyPresent = data.pages.some((page) =>
            page.items.some((item) => item.id === notification.id),
          );
          if (alreadyPresent) return data;

          const [firstPage, ...rest] = data.pages;
          return {
            ...data,
            pages: [{ ...firstPage, items: [notification, ...firstPage.items] }, ...rest],
          };
        },
      );
      void queryClient.invalidateQueries({ queryKey: queryKeys.unreadNotifications });
    };

    socket.on("connect", handleConnect);
    socket.on("disconnect", handleDisconnect);
    socket.on(SOCKET_EVENTS.messageNew, handleMessageNew);
    socket.on(SOCKET_EVENTS.messageDeleted, handleMessageDeleted);
    socket.on(SOCKET_EVENTS.messageRead, handleMessageRead);
    socket.on(SOCKET_EVENTS.messageTyping, handleTyping);
    socket.on(SOCKET_EVENTS.messageStopTyping, handleStopTyping);
    socket.on(SOCKET_EVENTS.presenceUpdate, handlePresence);
    socket.on(SOCKET_EVENTS.notificationNew, handleNotificationNew);

    return () => {
      socket.off("connect", handleConnect);
      socket.off("disconnect", handleDisconnect);
      socket.off(SOCKET_EVENTS.messageNew, handleMessageNew);
      socket.off(SOCKET_EVENTS.messageDeleted, handleMessageDeleted);
      socket.off(SOCKET_EVENTS.messageRead, handleMessageRead);
      socket.off(SOCKET_EVENTS.messageTyping, handleTyping);
      socket.off(SOCKET_EVENTS.messageStopTyping, handleStopTyping);
      socket.off(SOCKET_EVENTS.presenceUpdate, handlePresence);
      socket.off(SOCKET_EVENTS.notificationNew, handleNotificationNew);
      Object.values(timers).forEach(clearTimeout);

      /*
       * Presence and typing are cleared on the way out, not on the way in.
       *
       * This cleanup runs on sign-out and whenever the viewer changes, which
       * is precisely when the previous session's state stops being true — and
       * it is what keeps one user's presence set out of the next user's
       * session on a shared browser.
       */
      setIsConnected(false);
      setOnlineUserIds(new Set());
      setTypingByConversation({});
    };
  }, [isAuthenticated, viewerId, queryClient]);

  const joinConversation = useCallback((conversationId: string) => {
    getSocket().emit(SOCKET_EVENTS.conversationJoin, { conversationId });
  }, []);

  const leaveConversation = useCallback((conversationId: string) => {
    getSocket().emit(SOCKET_EVENTS.conversationLeave, { conversationId });
  }, []);

  const emitTyping = useCallback((conversationId: string, typing: boolean) => {
    getSocket().emit(
      typing ? SOCKET_EVENTS.messageTyping : SOCKET_EVENTS.messageStopTyping,
      { conversationId },
    );
  }, []);

  const value = useMemo<SocketContextValue>(
    () => ({
      isConnected,
      onlineUserIds,
      typingByConversation,
      joinConversation,
      leaveConversation,
      emitTyping,
    }),
    [
      isConnected,
      onlineUserIds,
      typingByConversation,
      joinConversation,
      leaveConversation,
      emitTyping,
    ],
  );

  return <SocketContext.Provider value={value}>{children}</SocketContext.Provider>;
}

export function useSocket(): SocketContextValue {
  const context = useContext(SocketContext);
  if (!context) {
    throw new Error("useSocket must be used inside <SocketProvider>");
  }
  return context;
}
