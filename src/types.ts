export type CouponResult = "success" | "rejected" | "error";

export interface HistoryEntry {
  code: string;
  result?: CouponResult;
  reason?: string;
}

export interface ExecutionPlan {
  id: string;
  createdAt: number;
  plan: string;
}

// ── Content script tool messages (Background → Content) ───────────────────

export interface GetPageInfoMessage  { type: "GET_PAGE_INFO" }
export interface FillInputMessage    { type: "FILL_INPUT"; selector: string; value: string }
export interface ClickElementMessage { type: "CLICK_ELEMENT"; selector: string }
export interface GetPageTextMessage  { type: "GET_PAGE_TEXT" }

// ── Page info returned by content script ──────────────────────────────────

export interface InputInfo {
  selector: string;
  inputType: string;
  placeholder: string;
  name: string;
  id: string;
  label: string;
}

export interface ButtonInfo {
  selector: string;
  text: string;
  id: string;
  buttonType: string;
}

export interface PageInfo {
  title: string;
  url: string;
  inputs: InputInfo[];
  buttons: ButtonInfo[];
}

// ── Port messages (Background → Popup) ────────────────────────────────────

export interface StatusUpdate {
  type: "STATUS";
  message: string;
  level: "info" | "success" | "error" | "warning";
}

export interface DoneUpdate {
  type: "DONE";
  result: CouponResult;
  code: string;
  code2?: string;
  reason?: string;
  reason2?: string;
  planUsed: boolean;
  inconsistent: boolean;
  run1Result?: CouponResult;
}

export interface PlanSavedUpdate {
  type: "PLAN_SAVED";
}

export interface BatchDoneUpdate {
  type: "BATCH_DONE";
  tested: number;
  good: number;
  bad: number;
  errors: number;
}

export type PortMessage = StatusUpdate | DoneUpdate | PlanSavedUpdate | BatchDoneUpdate;

// ── Popup → Background ────────────────────────────────────────────────────

export interface RunAiMessage {
  type: "RUN_AI";
  model: string;
  couponCode: string;
  couponCode2: string;
  tabId: number;
  hostname: string;
  correctionNotes?: string;
}

export interface GeneratePlanMessage {
  type: "GENERATE_PLAN";
  model: string;
  hostname: string;
}

export interface CollectCouponsMessage {
  type: "COLLECT_COUPONS";
  hostname: string;
}

export interface TestCouponsMessage {
  type: "TEST_COUPONS";
  model: string;
  tabId: number;
  hostname: string;
}

export interface StopSessionMessage {
  type: "STOP_SESSION";
}
