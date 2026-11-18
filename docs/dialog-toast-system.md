# Hệ thống Dialog & Toast thống nhất

Báo cáo kỹ thuật (tiếng Việt) cho việc thay thế `alert` / `confirm` / `prompt` gốc của trình duyệt bằng API bất đồng bộ, theme-aware và accessible trên toàn bộ frontend Hasaki.

## 1. Mục tiêu đã đạt

- Loại bỏ mọi lời gọi application-level tới native browser dialog trên `web/src` và classic `public/`.
- Một API Promise dùng chung: `dialog.confirm` / `dialog.alert` / `dialog.prompt`.
- Toast mở rộng: `toast.success` / `error` / `warning` / `info` / `loading` kèm dedupe và giới hạn stack.
- i18n VI/EN cho nhãn dialog; destructive styling nhất quán.
- ESLint + test tĩnh chặn tái xuất hiện native dialogs.

## 2. Kiểm kê call site (trước → sau)

| Khu vực | Trước | Sau | Mục đích |
| --- | --- | --- | --- |
| Chat | `confirm` xoá hội thoại | `dialog.confirm` destructive | Xoá conversation |
| StepInspector | `confirm` skip/stop | `dialog.confirm` warning/destructive | Bỏ qua / dừng bước |
| Integrations | `confirm` xoá DB / GitLab instance | `dialog.confirm` destructive | Xoá credential/config |
| RunView | `confirm` cancel/merge/close; `prompt` branch | `dialog.confirm` / `dialog.prompt` | Huỷ run, PR, sửa branch |
| Repositories | `confirm` xoá repo | `dialog.confirm` destructive | Gỡ đăng ký repo |
| RepositoryAccess | `confirm` bulk access | `dialog.confirm` | Cập nhật quyền hàng loạt |
| Settings | `window.confirm` restore | `dialog.confirm` destructive | Khôi phục mặc định |
| WorkflowEditor | `confirm` discard | `dialog.confirm` warning | Bỏ thay đổi chưa lưu |
| Knowledge | `prompt` lý do + `confirm` force | `dialog.prompt` + `dialog.confirm` | Xoá knowledge |
| Investigations | `window.confirm` fix | `dialog.confirm` warning | Mở phiên sửa |
| KnowledgeProposals | `confirm` bulk/rollback | `dialog.confirm` | Duyệt / từ chối / rollback |
| Questions | `confirm` reject | `dialog.confirm` destructive | Từ chối approval |
| Classic `public/app.js` | `confirm`/`prompt` | `appDialog.*` | Logout, cancel, skip, reset password, reexec |

### Ngoại lệ còn lại (không thay thế)

- `beforeunload` trên Settings / WorkflowEditor — bảo vệ điều hướng do trình duyệt kiểm soát.
- Hộp thoại quyền hệ thống (clipboard, notification, …) nếu có trong tương lai — ngoài phạm vi application UI.

## 3. Kiến trúc tái sử dụng

```
web/src/dialog/
  types.ts          # ConfirmOptions / AlertOptions / PromptOptions
  service.ts        # hàng đợi + Promise API (dialog.*)
  DialogHost.tsx    # render trên <Dialog> native modal hiện có
  DialogHost.css
  index.ts

web/src/Dialog.tsx  # primitive <dialog> (focus trap, portal) — đã mở rộng
web/src/ui.tsx      # toast + act (giữ trigger qua async dialog)
public/app-dialog.js # bản vanilla cho classic UI
```

`DialogHost` gắn tại root (`web/src/main.tsx`) cạnh `App`, bên trong `I18nProvider`.

## 4. API sử dụng

```ts
import { dialog } from "../dialog/index.ts";
import { toast } from "../ui.tsx";

const ok = await dialog.confirm({
  title: t("chat.delete.title"),
  description: t("chat.deleteConfirm"),
  confirmLabel: t("chat.delete.confirm"),
  cancelLabel: t("common.cancel"),
  variant: "destructive",
});
if (!ok) return;
await deleteConversation(id);
toast.success("…");

const name = await dialog.prompt({
  title: t("rv.editBranch.title"),
  defaultValue: current,
  required: false,
  confirmLabel: t("rv.editBranch.action"),
});
if (name === null) return;
```

Quy tắc:

- Mỗi promise settle đúng một lần.
- Escape / backdrop / unmount → cancel (`false` / `null`), không bao giờ confirm destructive.
- Focus mặc định vào nút an toàn (Cancel) với `variant: "destructive"`.
- Trong lúc dialog mở, `act()` vẫn nhớ nút gốc đã bấm (không bị ghi đè bởi nút Confirm).

## 5. Toast

- `toast(msg, "ok"|"err")` — tương thích ngược.
- `toast.success|error|warning|info|loading(msg, { description, id, dedupeMs, durationMs })`.
- Dedup theo `(kind, msg, description)` trong cửa sổ ngắn.
- Tối đa 5 toast hiển thị; loading có thể `update()` / `dismiss()` qua handle.

## 6. Kiểm soát hồi quy

- ESLint `no-restricted-globals` + `no-restricted-properties` trên `web/src` và `public`.
- `test/no-native-dialogs.test.ts` quét tĩnh.
- `test/dialog-service.test.ts` kiểm tra settle / queue / dismiss.

## 7. Ảnh minh họa

Thư mục `docs/validation/dialogs/` (từ `test/dialog-host.browser.ts`):

- `confirm-destructive-light.png` / `confirm-destructive-dark.png`
- `prompt-input-light.png`
- `alert-info-light.png`
- `confirm-mobile.png`

## 8. Hạn chế đã biết

- Classic UI dùng bản dialog vanilla riêng (`appDialog`) — cùng mô hình Promise, chưa chia sẻ bundle React.
- Typed confirmation (gõ lại tên resource) chưa bắt buộc cho hành động thường; có thể bổ sung qua `dialog.prompt` + `validate` khi cần.
- Screenshot React DialogHost trên staging vẫn hữu ích để đối chiếu theme token đầy đủ (browser test classic dùng CSS tối giản).

## 9. Kết quả kiểm tra

- `npm test` — pass (gồm `dialog-service`, `no-native-dialogs`).
- `npm run typecheck` — pass.
- `npm run build` — pass.
- `CHROMIUM_BIN=… node test/dialog-host.browser.ts` — pass + screenshots.
- ESLint `no-restricted-globals` / `no-restricted-properties` cho `alert`/`confirm`/`prompt` đã bật trên `web/src` và `public`.
