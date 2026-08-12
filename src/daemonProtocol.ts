import type { CaptureBackend, ScreencastCaptureSize } from "./captureBackend";
import type { PaneGraphicsPlacement, PaneGraphicsTarget } from "./herdrGraphics";
import type {
  BrowserAutomationDescriptor,
  BrowserNavigationResult,
  BrowserTabInfo,
} from "./browser";

export type { BrowserTabInfo } from "./browser";

export type DaemonState = {
  instanceId: string;
  pid: number;
  baseUrl: string;
  token: string;
  startedAt: string;
  captureBackend?: CaptureBackend;
  screencastEveryNthFrame?: 1 | 2;
  profileDir?: string;
  chromePid?: number | null;
  displayMode?: "headless" | "headful";
};

export type DaemonHealth = {
  ok: true;
  pid: number;
  chrome_pid: number | null;
  views: number;
};

export type BrowserViewResponse = {
  ok: true;
  viewId: string;
};

export type BrowserViewSelectionResponse = {
  ok: true;
  viewId: string | null;
};

export type BrowserViewInfo = {
  view_id: string;
  pane_id: string | null;
  created_at: string;
  active_target_id: string;
  url: string;
  title: string;
  tabs: BrowserTabInfo[];
};

export type BrowserViewListResponse = {
  ok: true;
  views: BrowserViewInfo[];
};

export type DaemonStatus = {
  ok: true;
  pid: number;
  chrome_pid: number | null;
  chrome_executable: string;
  chrome_cdp_port: number;
  url: string;
  title: string;
  captureBackend: CaptureBackend;
  display_mode?: "headless" | "headful";
  tabs: BrowserTabInfo[];
};

export type AutomationResponse = {
  ok: true;
} & BrowserAutomationDescriptor;

export type DaemonMetrics = {
  ok: true;
  started_at: string;
  requests: number;
  errors: number;
  screenshots: {
    count: number;
    total_ms: number;
    last_ms: number;
    last_bytes: number;
    backend: CaptureBackend;
  };
  graphics_stream: {
    active: boolean;
    started_at: string | null;
    frames_received: number;
    frames_sent: number;
    frames_coalesced: number;
    frames_dropped: number;
    errors: number;
    last_error: string | null;
    last_bytes: number;
    total_bytes: number;
    last_write_ms: number;
    total_write_ms: number;
    max_write_ms: number;
    last_frame_width: number;
    last_frame_height: number;
    last_frame_at: string | null;
  };
  viewport_updates: number;
  mouse_clicks: number;
  mouse_moves: number;
  mouse_wheels: number;
  key_events: number;
};

export type OpenResponse = {
  ok: true;
  url: string;
  title: string;
  navigated?: boolean;
  timed_out?: boolean;
};

export type NavigationResponse = {
  ok: true;
} & BrowserNavigationResult;

export type TabResponse = {
  ok: true;
} & BrowserTabInfo;

export type EvalResponse = {
  ok: true;
  value: unknown;
};

export type ScreenshotResponse = {
  ok: true;
  data: string;
};

export type ViewportResponse = {
  ok: true;
  width: number;
  height: number;
  deviceScaleFactor: number;
  pageScaleFactor: number;
};

export type GraphicsStreamRequest = {
  target: PaneGraphicsTarget;
  placement: PaneGraphicsPlacement;
  capture: ScreencastCaptureSize | null;
};

export type GraphicsStreamResponse = {
  ok: true;
  active: boolean;
  transport: "daemon-stream";
};

export type MouseMoveResponse = {
  ok: true;
  x: number;
  y: number;
};

export type MouseResponse = MouseMoveResponse & {
  nativeSelect: boolean;
};

export type NativeSelectAtPointResponse = {
  ok: true;
  nativeSelect: boolean;
};

export type WheelResponse = {
  ok: true;
  x: number;
  y: number;
  deltaX: number;
  deltaY: number;
};

export type KeyResponse = {
  ok: true;
};

export type PageTextResponse = {
  ok: true;
  text: string;
};

export type ConsoleResponse = {
  ok: true;
  entries: Array<{
    level: string;
    text: string;
    timestamp: number;
  }>;
};

export type SelectorClickResponse = {
  ok: true;
  selector: string;
  x: number;
  y: number;
};

export type SelectorTypeResponse = {
  ok: true;
  selector: string;
  text: string;
};

export type SelectorPressResponse = {
  ok: true;
  selector: string | null;
  key: string;
};

export type WaitResponse = {
  ok: true;
  value: unknown;
};

export type ErrorResponse = {
  ok: false;
  error: string;
};
