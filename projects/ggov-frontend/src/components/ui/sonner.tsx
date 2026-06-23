import { Toaster as SonnerToaster, type ToasterProps } from "sonner"

/**
 * Branded sonner Toaster. Every shape — success, error, neutral, success+action,
 * and the persistent/updating loading toast — renders as one Algorand-design-system
 * card: surface background, a 3px left accent stripe + tinted icon circle in the
 * status color (success=green, error=orange, info/loading=blue, warning=amber),
 * title (+ optional body), optional action button, and a close ✕.
 *
 * Themed entirely with design tokens via sonner's CSS-variable + `classNames` hooks,
 * so it flips with the app's `.dark` class and **no toast call-sites change**
 * (`mutations.ts`, `signingProgress.ts`, copy toasts all keep their plain
 * `toast.success/error/loading(...)` calls).
 */
export function Toaster(props: ToasterProps) {
  return (
    <SonnerToaster
      position="bottom-right"
      closeButton
      gap={10}
      {...props}
      style={
        {
          "--normal-bg": "var(--popover)",
          "--normal-text": "var(--popover-foreground)",
          "--normal-border": "var(--border)",
          "--border-radius": "var(--radius-md)",
          ...props.style,
        } as React.CSSProperties
      }
      toastOptions={{
        classNames: {
          toast:
            "group font-sans rounded-md! shadow-lg! border! border-border! bg-popover! text-popover-foreground! " +
            "data-[type=success]:border-l-[3px]! data-[type=success]:border-l-success! " +
            "data-[type=error]:border-l-[3px]! data-[type=error]:border-l-destructive! " +
            "data-[type=info]:border-l-[3px]! data-[type=info]:border-l-primary! " +
            "data-[type=warning]:border-l-[3px]! data-[type=warning]:border-l-warning! " +
            "data-[type=loading]:border-l-[3px]! data-[type=loading]:border-l-primary!",
          icon:
            "flex size-[30px] shrink-0 items-center justify-center rounded-full m-0! [&>svg]:size-4 " +
            "group-data-[type=success]:bg-success/15 group-data-[type=success]:text-success-strong " +
            "group-data-[type=error]:bg-destructive/15 group-data-[type=error]:text-destructive-strong " +
            "group-data-[type=warning]:bg-warning/25 group-data-[type=warning]:text-warning-strong " +
            "group-data-[type=info]:bg-primary/15 group-data-[type=info]:text-primary " +
            "group-data-[type=loading]:text-primary",
          title: "font-sans text-sm font-semibold text-foreground",
          description: "font-sans text-xs text-muted-foreground!",
          actionButton:
            "bg-primary/10! text-primary! rounded-sm! px-2.5! py-1.5! text-xs! font-semibold! font-sans!",
          closeButton:
            "border-border! bg-popover! text-muted-foreground! hover:text-foreground!",
          loader: "text-primary",
        },
      }}
    />
  )
}
