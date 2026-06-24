import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { cn } from "@/lib/utils"

const tagVariants = cva(
  "inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-xs font-semibold leading-none",
  {
    variants: {
      tone: {
        // Solid teal chip with readable text in both themes (the design's
        // "Top N% of producers" pill — a solid chip, not an outline tag).
        teal: "bg-algo-teal text-[#001324]",
        blue: "bg-algo-blue text-white",
        neutral: "bg-muted text-muted-foreground",
      },
    },
    defaultVariants: {
      tone: "teal",
    },
  },
)

export interface TagProps
  extends React.HTMLAttributes<HTMLSpanElement>,
    VariantProps<typeof tagVariants> {}

/** Small pill/chip label (design-system "Tag"). */
export function Tag({ className, tone, ...props }: TagProps) {
  return <span className={cn(tagVariants({ tone }), className)} {...props} />
}
