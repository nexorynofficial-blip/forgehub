"use client";

import { useQuery } from "@tanstack/react-query";
import { motion } from "framer-motion";
import { Quote } from "lucide-react";

import { getTestimonials } from "@/lib/services/marketing-service";
import { Container } from "@/components/layout/container";
import { Section } from "@/components/layout/section";
import { AmbientGlow } from "@/components/marketing/ambient-glow";
import { RevealOnScroll } from "@/components/motion/reveal-on-scroll";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

export function TestimonialsSection() {
  const { data: testimonials, isLoading } = useQuery({
    queryKey: ["testimonials"],
    queryFn: getTestimonials,
  });

  return (
    <Section id="testimonials" className="bg-surface/50">
      <AmbientGlow variant="primary" className="-bottom-40 -left-32" />

      <Container>
        <RevealOnScroll blur className="mx-auto max-w-2xl text-center">
          <h2 className="font-display text-3xl font-semibold tracking-tight sm:text-4xl">
            Builders are already here
          </h2>
          <p className="text-muted-foreground mt-4 text-lg">
            Real people, real progress — not case studies written by marketing.
          </p>
        </RevealOnScroll>

        <div className="mt-16 grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-4">
          {isLoading || !testimonials
            ? Array.from({ length: 4 }).map((_, i) => (
                <Card key={i}>
                  <CardContent className="flex flex-col gap-4 pt-6">
                    <Skeleton className="h-16 w-full" />
                    <div className="flex items-center gap-3">
                      <Skeleton className="size-9 rounded-full" />
                      <Skeleton className="h-4 w-24" />
                    </div>
                  </CardContent>
                </Card>
              ))
            : testimonials.map((testimonial, index) => (
                <RevealOnScroll key={testimonial.id} delay={index * 0.06}>
                  <motion.div
                    whileHover={{ scale: 1.015 }}
                    transition={{ type: "spring", stiffness: 400, damping: 25 }}
                    className="h-full"
                  >
                    <Card className="hover:border-primary/40 flex h-full flex-col transition-[border-color,box-shadow] hover:shadow-[var(--shadow-glow-primary)]">
                      <CardContent className="flex flex-1 flex-col gap-4 pt-6">
                        <Quote className="text-primary size-5" />
                        <p className="text-foreground flex-1 text-sm leading-relaxed">
                          “{testimonial.quote}”
                        </p>
                        <div className="flex items-center gap-3">
                          <Avatar className="size-9">
                            <AvatarFallback>
                              {testimonial.authorName.charAt(0)}
                            </AvatarFallback>
                          </Avatar>
                          <div>
                            <p className="text-foreground text-sm font-medium">
                              {testimonial.authorName}
                            </p>
                            <p className="text-muted-foreground text-xs">
                              {testimonial.authorRole}
                            </p>
                          </div>
                        </div>
                      </CardContent>
                    </Card>
                  </motion.div>
                </RevealOnScroll>
              ))}
        </div>
      </Container>
    </Section>
  );
}
