"use client";

import * as React from "react";

import { cn } from "@/lib/utils";

interface OtpInputProps {
  length?: number;
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  autoFocus?: boolean;
  "aria-invalid"?: boolean;
}

/** Accessible digit-by-digit code entry for 2FA (no Radix equivalent exists). */
export function OtpInput({
  length = 6,
  value,
  onChange,
  disabled,
  autoFocus,
  "aria-invalid": ariaInvalid,
}: OtpInputProps) {
  const inputRefs = React.useRef<Array<HTMLInputElement | null>>([]);
  const digits = React.useMemo(() => {
    const chars = value.split("");
    return Array.from({ length }, (_, i) => chars[i] ?? "");
  }, [value, length]);

  function setDigitAt(index: number, digit: string) {
    const next = digits.slice();
    next[index] = digit;
    onChange(next.join(""));
  }

  function handleChange(index: number, rawInput: string) {
    const digitsOnly = rawInput.replace(/\D/g, "");
    if (!digitsOnly) {
      setDigitAt(index, "");
      return;
    }
    // Handles both single keystrokes and a full paste landing in one box.
    const chars = digitsOnly.split("");
    const next = digits.slice();
    let cursor = index;
    for (const char of chars) {
      if (cursor >= length) break;
      next[cursor] = char;
      cursor += 1;
    }
    onChange(next.join(""));
    inputRefs.current[Math.min(cursor, length - 1)]?.focus();
  }

  function handleKeyDown(index: number, event: React.KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Backspace" && !digits[index] && index > 0) {
      inputRefs.current[index - 1]?.focus();
      setDigitAt(index - 1, "");
    } else if (event.key === "ArrowLeft" && index > 0) {
      inputRefs.current[index - 1]?.focus();
    } else if (event.key === "ArrowRight" && index < length - 1) {
      inputRefs.current[index + 1]?.focus();
    }
  }

  return (
    <div role="group" aria-label="Verification code" className="flex gap-2 sm:gap-3">
      {digits.map((digit, index) => (
        <input
          key={index}
          ref={(el) => {
            inputRefs.current[index] = el;
          }}
          type="text"
          inputMode="numeric"
          autoComplete={index === 0 ? "one-time-code" : "off"}
          maxLength={1}
          value={digit}
          disabled={disabled}
          autoFocus={autoFocus && index === 0}
          aria-label={`Digit ${index + 1} of ${length}`}
          aria-invalid={ariaInvalid}
          onChange={(e) => handleChange(index, e.target.value)}
          onKeyDown={(e) => handleKeyDown(index, e)}
          className={cn(
            "border-border bg-surface text-foreground size-11 rounded-md border text-center text-lg font-medium sm:size-12",
            "focus-visible:ring-ring focus-visible:ring-2 focus-visible:outline-none",
            "aria-invalid:border-danger aria-invalid:ring-danger",
            "disabled:cursor-not-allowed disabled:opacity-50",
          )}
        />
      ))}
    </div>
  );
}
