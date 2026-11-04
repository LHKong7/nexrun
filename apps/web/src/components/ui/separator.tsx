// Source: https://ui.shadcn.com/r/styles/base-nova/separator.json
// Copyright (c) 2023 shadcn. MIT; see vendor/shadcn/LICENSE.
// Adapted for local imports, Lucide icons, localization and Tailwind 3 composition.
"use client"

import { Separator as SeparatorPrimitive } from "@base-ui/react/separator"
import { cn } from "@/lib/utils"

function Separator({
  className,
  orientation = "horizontal",
  ...props
}: SeparatorPrimitive.Props) {
  return (
    <SeparatorPrimitive
      data-slot="separator"
      orientation={orientation}
      className={cn(
        "shrink-0 bg-border data-horizontal:h-px data-horizontal:w-full data-vertical:w-px data-vertical:self-stretch",
        className
      )}
      {...props}
    />
  )
}

export { Separator }
