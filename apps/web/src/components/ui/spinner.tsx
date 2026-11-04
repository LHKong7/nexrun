// Source: https://ui.shadcn.com/r/styles/base-nova/spinner.json
// Copyright (c) 2023 shadcn. MIT; see vendor/shadcn/LICENSE.
// Adapted for local imports, Lucide icons, localization and Tailwind 3 composition.
import { Loader2Icon } from "lucide-react"
import { cn } from "@/lib/utils"


function Spinner({ className, ...props }: React.ComponentProps<"svg">) {
  return (
    <Loader2Icon
      data-slot="spinner"
      role="status"
      aria-label="Loading"
      className={cn("size-4 animate-spin", className)}
      {...props}
    />
  )
}

export { Spinner }
