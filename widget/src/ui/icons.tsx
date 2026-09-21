import type { ComponentChildren } from 'preact'

function Svg({ size = 20, children, fill = 'none' }: { size?: number; children: ComponentChildren; fill?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill={fill}
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {children}
    </svg>
  )
}

export const LauncherIcon = () => (
  <Svg size={26}>
    <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z" />
  </Svg>
)
export const CloseIcon = ({ size = 20 }: { size?: number }) => (
  <Svg size={size}>
    <path d="M18 6 6 18M6 6l12 12" />
  </Svg>
)
export const BackIcon = () => (
  <Svg>
    <path d="M15 18l-6-6 6-6" />
  </Svg>
)
export const SendIcon = () => (
  <Svg size={20}>
    <path d="M22 2 11 13M22 2l-7 20-4-9-9-4 20-7Z" />
  </Svg>
)
export const MicIcon = () => (
  <Svg size={22}>
    <path d="M12 15a3 3 0 0 0 3-3V6a3 3 0 0 0-6 0v6a3 3 0 0 0 3 3z" />
    <path d="M19 11a7 7 0 0 1-14 0M12 18v3" />
  </Svg>
)
export const SmileIcon = () => (
  <Svg size={22}>
    <circle cx="12" cy="12" r="9" />
    <path d="M8 14s1.5 2 4 2 4-2 4-2M9 9.5h.01M15 9.5h.01" />
  </Svg>
)
export const KeyboardIcon = () => (
  <Svg size={22}>
    <rect x="2" y="5" width="20" height="14" rx="2" />
    <path d="M6 9h.01M10 9h.01M14 9h.01M18 9h.01M7 15h10" />
  </Svg>
)
export const PaperclipIcon = () => (
  <Svg size={22}>
    <path d="M21.4 11.1l-9.2 9.2a6 6 0 0 1-8.5-8.5l9.2-9.2a4 4 0 0 1 5.7 5.7l-9.2 9.2a2 2 0 0 1-2.8-2.8l8.5-8.5" />
  </Svg>
)
export const TrashIcon = () => (
  <Svg size={20}>
    <path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6M10 11v6M14 11v6" />
  </Svg>
)
export const PlayIcon = () => (
  <Svg size={20} fill="currentColor">
    <path d="M7 4.5v15l13-7.5z" stroke="none" />
  </Svg>
)
export const PauseIcon = () => (
  <Svg size={20} fill="currentColor">
    <path d="M6 4h4v16H6zM14 4h4v16h-4z" stroke="none" />
  </Svg>
)
export const FileIcon = () => (
  <Svg size={22}>
    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
    <path d="M14 2v6h6" />
  </Svg>
)
export const DownloadIcon = () => (
  <Svg size={18}>
    <path d="M12 3v12M7 10l5 5 5-5M5 21h14" />
  </Svg>
)
export const ArrowDownIcon = () => (
  <Svg size={18}>
    <path d="M12 5v14M5 12l7 7 7-7" />
  </Svg>
)
export const SearchIcon = () => (
  <Svg size={16}>
    <circle cx="11" cy="11" r="7" />
    <path d="M21 21l-4.3-4.3" />
  </Svg>
)

/** Message ticks — 16px, drawn thin like a chat app. */
export const ClockTick = () => (
  <Svg size={14}>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 7v5l3 2" />
  </Svg>
)
export const SingleTick = () => (
  <Svg size={16}>
    <path d="M5 13l4 4L19 7" />
  </Svg>
)
export const DoubleTick = () => (
  <Svg size={16}>
    <path d="M1.5 13l4 4L15 7" />
    <path d="M9 16.5l1 1L21 7" />
  </Svg>
)
export const FailedTick = () => (
  <Svg size={15}>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 7v6M12 16.5h.01" />
  </Svg>
)
