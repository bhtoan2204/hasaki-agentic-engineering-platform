/** UI copy, namespace "handoff.*". Keys must exist in both locales. */
export const handoffMessages: Record<"vi" | "en", Record<string, string>> = {
  vi: {
    "handoff.accountDefault": "Mặc định tài khoản",
    "handoff.blockedDetail":
      "Cursor và các agent khác vẫn không chạy được cho đến khi checkpoint sẵn sàng. Xử lý vấn đề workspace bên dưới, bấm Kiểm tra lại, rồi chọn agent và xác nhận.",
    "handoff.checkingAgents": "Đang kiểm tra agent…",
    "handoff.checkingProvider": "Đang kiểm tra khả dụng…",
    "handoff.confirmResume": "Xác nhận tiếp tục",
    "handoff.manualSwitch": "Chuyển thủ công",
    "handoff.noneReady": "Không có agent nào sẵn sàng",
    "handoff.reinspect": "Kiểm tra lại trạng thái đã lưu",
    "handoff.retryCheck": "Kiểm tra lại khả dụng",
    "handoff.reviewCheckpointHint": "Tick ô đã xem checkpoint để bật nút Xác nhận tiếp tục.",
    "handoff.reviewedCheckpoint": "Đã xem checkpoint và file đã lưu",
    "handoff.stopping":
      "Đã yêu cầu huỷ. Đang chờ tiến trình kết thúc và kiểm tra Git ổn định. Chưa thể chạy agent tiếp theo.",
    "handoff.switchBtn": "Chuyển agent",
    "handoff.targetModel": "Model tiếp theo",
    "handoff.targetProvider": "Provider tiếp theo",
    "handoff.title": "Bàn giao agent",
    "handoff.userSwitchReason": "Người dùng yêu cầu chuyển provider",
    "handoff.cliReady":
      "CLI đã sẵn sàng. Chưa biết hạn mức còn lại và chi phí; trạng thái sẵn sàng không bảo đảm yêu cầu sẽ thành công.",
    "handoff.confirmCheckbox":
      "Tôi đã xem checkpoint và thay đổi được giữ lại, đồng ý tiếp tục với agent này, bao gồm chi phí/sử dụng chưa được báo cáo.",
    "handoff.historyTimeline": "Lịch sử bàn giao và dòng thời gian agent",
    "handoff.holdLoading": "Nút tắt trong lúc đang kiểm tra agent nào chạy được.",
    "handoff.holdNotReady": "Nút tắt cho đến khi checkpoint ở trạng thái READY.",
    "handoff.holdNotReadyAgent": "Nút tắt vì agent này chưa sẵn sàng.",
    "handoff.nextNotStarted": "Agent tiếp theo chưa được chạy",
    "handoff.reinspectReason": "Người dùng yêu cầu kiểm tra lại checkpoint",
  },
  en: {
    "handoff.accountDefault": "Account default",
    "handoff.blockedDetail":
      "Cursor and the other agents stay unavailable until this checkpoint is ready. Reinspect after the workspace issue below is resolved, then choose the agent and confirm.",
    "handoff.checkingAgents": "Checking agents…",
    "handoff.checkingProvider": "Checking provider availability…",
    "handoff.confirmResume": "Confirm resume",
    "handoff.manualSwitch": "Manual switch",
    "handoff.noneReady": "No agent is ready",
    "handoff.reinspect": "Reinspect preserved state",
    "handoff.retryCheck": "Retry availability check",
    "handoff.reviewCheckpointHint": "Tick the checkpoint review box to enable Confirm resume.",
    "handoff.reviewedCheckpoint": "Reviewed preserved checkpoint and files",
    "handoff.stopping":
      "Cancellation requested. Waiting for executor termination and stable Git inspection. No continuation can start yet.",
    "handoff.switchBtn": "Switch Agent",
    "handoff.targetModel": "Target model",
    "handoff.targetProvider": "Target provider",
    "handoff.title": "Agent handoff",
    "handoff.userSwitchReason": "User requested provider switch",
    "handoff.cliReady":
      "CLI readiness confirmed. Remaining quota and billing are unknown; readiness does not guarantee a successful request.",
    "handoff.confirmCheckbox":
      "I reviewed the checkpoint and preserved changes, and authorize continuation with this provider, including unreported usage/cost.",
    "handoff.historyTimeline": "Handoff history & provider timeline",
    "handoff.holdLoading": "The button stays off while agent availability is still loading.",
    "handoff.holdNotReady": "The button stays off until the checkpoint status is READY.",
    "handoff.holdNotReadyAgent": "The button stays off because this agent is not ready.",
    "handoff.nextNotStarted": "The next agent has not started",
    "handoff.reinspectReason": "User requested checkpoint reinspection",
  },
};
