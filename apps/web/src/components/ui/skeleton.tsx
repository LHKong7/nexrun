// Source: https://ui.shadcn.com/r/styles/base-nova/skeleton.json
// Copyright (c) 2023 shadcn. MIT; see vendor/shadcn/LICENSE.
// Adapted for local imports, Lucide icons, localization and Tailwind 3 composition.
import { cn } from "@/lib/utils"

function Skeleton({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="skeleton"
      className={cn("animate-pulse rounded-md bg-muted", className)}
      {...props}
    />
  )
}

export { Skeleton }
