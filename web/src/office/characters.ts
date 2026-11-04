import type { Role } from "./types.ts";

/**
 * Character configuration for the Agent Office — the ONLY place for names, titles, personalities and looks.
 * Workflow mapping (workflowToAgentMapper.ts) decides which role a step belongs to; it never hard-codes how a
 * character looks or is called. Each character is a logical workflow role, not an independent AI worker.
 */
export type HairStyle = "bob" | "spiky" | "short" | "ponytail" | "bun" | "cap";

export interface CharacterConfig {
  name: string;
  title: string;
  /** What the role does in a workflow (tooltip / details). */
  does: string;
  personality: string;
  look: {
    skin: [string, string];
    hair: [string, string];
    hairStyle: HairStyle;
    glasses?: "square" | "round";
    /** Extra accessory drawn by the sprite builder. */
    accessory?: "pencil" | "headphones" | "hairtie" | "cap";
    pants: string;
  };
}

export const CHARACTERS: Record<Role, CharacterConfig> = {
  analyst: {
    name: "Tuấn",
    title: "Analyst",
    does: "Đọc yêu cầu, phân tích, đặt câu hỏi",
    personality: "Tỉ mỉ, luôn hỏi “tại sao?” trước khi bắt tay vào việc",
    look: { skin: ["#f8d7bb", "#e8b994"], hair: ["#4a3326", "#6e4c37"], hairStyle: "bob", glasses: "square", pants: "#33405e" },
  },
  architect: {
    name: "Duy",
    title: "Architect",
    does: "Lên kế hoạch và thiết kế giải pháp",
    personality: "Nghĩ bằng sơ đồ, không rời cây bút dạ",
    look: { skin: ["#eec29b", "#d6a37a"], hair: ["#23222e", "#3c3a4d"], hairStyle: "spiky", accessory: "pencil", pants: "#2f2f3d" },
  },
  developer: {
    name: "Con Claude của Toàn =))))",
    title: "Developer",
    does: "Viết code trong worktree của run",
    personality: "Đeo tai nghe, gõ phím như rap",
    look: { skin: ["#f5cfab", "#e2b089"], hair: ["#2a3047", "#45507a"], hairStyle: "short", accessory: "headphones", pants: "#2b3550" },
  },
  tester: {
    name: "Hằng",
    title: "Tester",
    does: "Chạy test và so với baseline",
    personality: "Không tin bất cứ thứ gì chưa có test xanh",
    look: { skin: ["#fadcc2", "#ebbf9c"], hair: ["#9a4421", "#c0602f"], hairStyle: "ponytail", accessory: "hairtie", pants: "#3a3550" },
  },
  reviewer: {
    name: "Ngọc và Thiên",
    title: "Reviewer",
    does: "Review diff, bảo mật, kiến trúc",
    personality: "Đọc từng dòng diff, gật gù khi ổn",
    look: { skin: ["#e9bb92", "#cf9b70"], hair: ["#33213d", "#563a66"], hairStyle: "bun", glasses: "round", pants: "#3b3040" },
  },
  pr: {
    name: "Toàn",
    title: "PR Agent",
    does: "Đóng gói thay đổi, mở PR, viết báo cáo",
    personality: "Đóng gói gọn gàng như đơn hàng Hasaki",
    look: { skin: ["#f3cba5", "#dcab82"], hair: ["#5a3b25", "#7a5236"], hairStyle: "cap", accessory: "cap", pants: "#33405e" },
  },
};
