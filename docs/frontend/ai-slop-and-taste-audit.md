# AI Slop & Taste Audit — `web/src/`

Báo cáo audit toàn bộ frontend `web/src/` (`170` files CSS/TSX) bằng **Hallmark** (`sloplint.mjs --scope app`), **unslop**, và **Taste Skill**, đối chiếu trực tiếp với [UI quality standards](ui-quality-standards.md) của repository.

> [!NOTE]
> **Bối cảnh & phạm vi:** `hasaki-orbit` là ứng dụng dashboard kỹ thuật / observability nội bộ (Workflow Editor, Run View, Production Errors, Insights, Knowledge), **không phải marketing landing page**. Các rule của Taste Skill/Hallmark chỉ dành riêng cho landing page (như 1-section-per-screen 100vh, WebGL shader, `footer.closing`, hoặc cấm ký tự `—` ở ô số null `fmtInt`) đã được lọc bỏ. Các màu pixel-art trong `web/src/office/office.css` cũng được xem là tài nguyên minh họa riêng của Agent Office, không tính là lỗi UI chrome.

---

## Tóm tắt kết quả quét tự động (`sloplint.mjs --scope app`)

Chạy `node .agents/skills/hallmark/scripts/sloplint.mjs web/src --scope app --json` trên `170` files:
- **Floor (`FAIL`):** `268` findings (tập trung ở màu literal ngoài token `Gate 48`: `137`, pure `#fff` `Gate 7a`: `19`, chữ hoa tracked `Gate 67`: `27`, middle-dot meta `Gate 63`: `18`, `100vw` gây tràn scrollbar `Gate 34`: `7`, animate `width`/`left` `Gate 10a`: `6`, card lồng card `Gate 4`: `4`, emoji icon `Gate 30a`: `3`, contrast thấp `Gate 40`: `2`).
- **Reflex:** `622` findings (chủ yếu `Gate 24b` spacing lệch thang 4px như `2px`, `6px`, `7px`, `10px`, `14px`).
- **Finish:** `12` findings.

---

## P0 — Lỗi kỹ thuật / CSS hard-floor cần sửa ngay

Các lỗi này vi phạm trực tiếp **Hallmark Floor** và/hoặc [UI quality standards](ui-quality-standards.md) (§4, §5, §7, §8, §10):

| # | Phân loại | Vị trí (`file:line`) | Vấn đề & đối chiếu `ui-quality-standards.md` | Hướng sửa đề xuất |
|---|---|---|---|---|
| 1 | **Contrast < 4.5:1 & `#fff` cứng (dark mode)** | [styles.css:939-949](file:///home/toan/hasaki-orbit/web/src/styles.css#L939-L949) (`.count`), [ProdErrors.css:113](file:///home/toan/hasaki-orbit/web/src/pages/ProdErrors.css#L113), [ProdErrors.css:454](file:///home/toan/hasaki-orbit/web/src/pages/ProdErrors.css#L454), [Intake.css:267](file:///home/toan/hasaki-orbit/web/src/pages/Intake.css#L267), [WorkItems.css:91](file:///home/toan/hasaki-orbit/web/src/pages/WorkItems.css#L91), [Questions.css:176](file:///home/toan/hasaki-orbit/web/src/pages/Questions.css#L176) | `.count` dùng `background: var(--brand); color: #fff;` → ở dark theme (`--brand: #5cc28f`), độ tương phản chỉ đạt **2.19:1** (< 4.5:1 WCAG AA). Vi phạm trực tiếp §8 (*"Use `--on-brand` for dark theme's bright brand background"*). | Thay `color: #fff` trên nền `--brand` bằng `color: var(--on-brand)`; các nút danger/critical dùng token foreground riêng. |
| 2 | **`.live-pill.is-sse i` tự trùng màu text/fill** | [styles.css:1628-1632](file:///home/toan/hasaki-orbit/web/src/styles.css#L1628-L1632) | `.live-pill.is-sse i` đặt cả `background: var(--st-ok)` và `color: var(--st-ok)` (contrast 1.00:1) kèm animation `livepulse` vô hạn. | Bỏ `color` thừa trên dot `<i>`; giữ `aria-hidden` và cân nhắc bỏ pulse nếu không thật sự đang stream. |
| 3 | **Màu literal ngoài `:root` tokens** | [DialogHost.css:28-44](file:///home/toan/hasaki-orbit/web/src/dialog/DialogHost.css#L28-L44), [DialogHost.css:84](file:///home/toan/hasaki-orbit/web/src/dialog/DialogHost.css#L84), [DialogHost.css:97-99](file:///home/toan/hasaki-orbit/web/src/dialog/DialogHost.css#L97-L99) | Dùng `#16a34a`, `#dc2626`, `#d97706`, `#fff` làm fallback hoặc giá trị cứng thay vì hoàn toàn đi qua CSS tokens trong `styles.css`. | Bỏ fallback hex cứng, dùng trực tiếp `var(--brand)`, `var(--st-err)`, `var(--st-warn)`, `var(--on-brand)`. |
| 4 | **`100vw` gây tràn ngang khi có scrollbar** | [styles.css:1207](file:///home/toan/hasaki-orbit/web/src/styles.css#L1207) (`.drawer`), [styles.css:1241](file:///home/toan/hasaki-orbit/web/src/styles.css#L1241), [DialogHost.css:2](file:///home/toan/hasaki-orbit/web/src/dialog/DialogHost.css#L2), [Settings.css:832](file:///home/toan/hasaki-orbit/web/src/pages/Settings.css#L832), [shell-account.css:59](file:///home/toan/hasaki-orbit/web/src/shell-account.css#L59), [companion.css:9](file:///home/toan/hasaki-orbit/web/src/office/companion.css#L9), [ui.tsx:526](file:///home/toan/hasaki-orbit/web/src/ui.tsx#L526) | `width: min(..., 100vw)` hoặc `calc(100vw - ...)` không trừ chiều rộng vertical scrollbar hệ thống trên Linux/Windows, dễ tạo tràn ngang 15–17px. | Đổi sang `width: min(..., 100%)` với container padding hoặc `100dvw` / `calc(100% - 32px)`. |
| 5 | **Animate layout properties (`width`, `left`)** | [Cost.css:58](file:///home/toan/hasaki-orbit/web/src/components/Cost.css#L58), [Insights.css:165](file:///home/toan/hasaki-orbit/web/src/pages/Insights.css#L165), [ProdErrors.css:354](file:///home/toan/hasaki-orbit/web/src/pages/ProdErrors.css#L354), [ProdErrors.css:368](file:///home/toan/hasaki-orbit/web/src/pages/ProdErrors.css#L368), [RunView.css:363](file:///home/toan/hasaki-orbit/web/src/pages/RunView.css#L363) | `transition: width` / `transition: left` kích hoạt layout reflow mỗi frame. | Đổi sang `transform: scaleX(...)` (`transform-origin: left`) hoặc `transform: translateX(...)`. |
| 6 | **Focus-visible thiếu ở một số component & `:focus` chỉ đổi border** | [Settings.css:353](file:///home/toan/hasaki-orbit/web/src/pages/Settings.css#L353) (`.agent-combobox input:focus`), và toàn bộ `Questions.css`, `WorkItems.css`, `Knowledge.css`, `Repositories.css`, `Overview.css`, `Runs.css` chưa có `:focus-visible` riêng | Chỉ `10` file CSS có `:focus-visible`; `.agent-combobox` dùng `:focus` đổi border đơn thuần. Vi phạm §8 (*"visible `:focus-visible`"*). | Kế thừa ring focus chuẩn từ `styles.css` (`box-shadow: 0 0 0 3px var(--focus)`) cho custom combobox/card interactive. |
| 7 | **Card lồng card (nested containment)** | [AgentSettings.tsx:425](file:///home/toan/hasaki-orbit/web/src/pages/AgentSettings.tsx#L425), [AgentSettings.tsx:447](file:///home/toan/hasaki-orbit/web/src/pages/AgentSettings.tsx#L447), [ReexecuteDialog.tsx:167](file:///home/toan/hasaki-orbit/web/src/pages/StepInspector/ReexecuteDialog.tsx#L167), [TestFailurePanel.tsx:79](file:///home/toan/hasaki-orbit/web/src/pages/StepInspector/TestFailurePanel.tsx#L79) | Đặt `.agent-defaults-card`, `.agent-profiles-card`, `.rv-card.soft` bên trong một card/dialog đã có viền và nền riêng. | Gỡ viền/nền card lớp trong, chỉ dùng divider (`border-top`) hoặc khoảng cách `gap`. |
| 8 | **Emoji thay cho icon kỹ thuật** | [WorkItems.tsx:1089](file:///home/toan/hasaki-orbit/web/src/pages/WorkItems.tsx#L1089) (`⏭`, `✅`, `❌`), [WorkItems.tsx:1124](file:///home/toan/hasaki-orbit/web/src/pages/WorkItems.tsx#L1124) (`❓`), [WorkItems.tsx:1129](file:///home/toan/hasaki-orbit/web/src/pages/WorkItems.tsx#L1129) (`✋`) | Dùng emoji hệ điều hành không đồng nhất giữa Linux/macOS/Windows trong khi toàn app đã dùng `lucide-react`. | Thay bằng icon `lucide-react` (`SkipForward`, `Check`, `X`, `HelpCircle`, `Hand`) kích thước `14px`. |
| 9 | **`overflow-x: hidden` trên container cuộn** | [styles.css:2290](file:///home/toan/hasaki-orbit/web/src/styles.css#L2290) (`.inspector`), [Insights.css:116](file:///home/toan/hasaki-orbit/web/src/pages/Insights.css#L116) (`.ins-bars`) | `overflow-x: hidden` có thể cắt ngang nội dung dài hoặc làm hỏng `position: sticky` bên trong. | Đổi sang `overflow-x: clip` (hoặc đảm bảo `min-width: 0` + `overflow-wrap: anywhere` ở children). |
| 10 | **Hai phần tử `sticky top: 0` chồng chéo** | [Repositories.css:25](file:///home/toan/hasaki-orbit/web/src/pages/Repositories.css#L25) | `.kn-list`, `.repo-side`, `.repo-detail-side`, `.si-body` khai báo `sticky` ở cùng ngữ cảnh cuộn. | Kiểm tra từng pane để chỉ giữ `sticky` ở cột thực sự cần cố định trên desktop và tắt ở `< 900px`. |

---

## P1 — AI slop gây rối mắt (sửa theo từng component nhỏ)

Phân tích theo tiêu chí **unslop** (bộ lọc cho dashboard kỹ thuật):

1. **Gradient trang trí lặp lại ("vibecoded hero/card wash") trên màn hình kỹ thuật:**
   - [Overview.css:16-34](file:///home/toan/hasaki-orbit/web/src/pages/Overview.css#L16-L34): `.ov-hero` dùng `radial-gradient` + `linear-gradient` + pseudo-element `::after` hình tròn mờ góc phải — đúng mẫu "glossy blob" của AI UI.
   - Các file [Knowledge.css:38,178,321](file:///home/toan/hasaki-orbit/web/src/pages/Knowledge.css#L38), [WorkItems.css:259,407,612](file:///home/toan/hasaki-orbit/web/src/pages/WorkItems.css#L259), [Insights.css:75,302](file:///home/toan/hasaki-orbit/web/src/pages/Insights.css#L75), [Repositories.css:164,330](file:///home/toan/hasaki-orbit/web/src/pages/Repositories.css#L164), [Workflows.css:71,205,239](file:///home/toan/hasaki-orbit/web/src/pages/Workflows.css#L71), [RunView.css:58,241](file:///home/toan/hasaki-orbit/web/src/pages/RunView.css#L58), [Chat.css:236,326](file:///home/toan/hasaki-orbit/web/src/pages/Chat.css#L236) đều lặp lại cùng công thức `linear-gradient(135deg, var(--brand-50), var(--blush))`.
   - **Đề xuất:** Giữ nền phẳng `var(--surface)` hoặc `var(--surface-2)` với 1px border `var(--line)` để dữ liệu/bảng/log nổi bật hơn; chỉ giữ tối đa 1 điểm nhấn màu có chủ đích.

2. **Quá nhiều pill / badge / chip bo tròn (`border-radius: var(--r-pill)`) gây nhiễu thị giác:**
   - Phát hiện **48+ rule** dùng `border-radius: var(--r-pill)` / `999px` trong CSS, tập trung dày đặc ở [KnowledgeProposals.tsx](file:///home/toan/hasaki-orbit/web/src/pages/KnowledgeProposals.tsx) (19 chỗ), [Knowledge.tsx](file:///home/toan/hasaki-orbit/web/src/pages/Knowledge.tsx) (12 chỗ), [Settings.css](file:///home/toan/hasaki-orbit/web/src/pages/Settings.css) (9 chỗ), [Insights.css](file:///home/toan/hasaki-orbit/web/src/pages/Insights.css) (6 chỗ), [CodeScan.tsx](file:///home/toan/hasaki-orbit/web/src/pages/prodErrors/CodeScan.tsx) (6 chỗ).
   - Khi mọi metadata (scope, provider, status, tag, count) đều đóng khung pill, mắt người dùng mất điểm neo để phân biệt trạng thái hành động vs nhãn tĩnh.
   - **Đề xuất:** Giữ pill cho **trạng thái live/hành động** (running/failed/warning); chuyển metadata tĩnh (provider name, scope, category) sang text thuần hoặc tabular label nhẹ không viền.

3. **Nhãn chữ hoa giãn chữ (`UPPERCASE` + `letter-spacing`) và chuỗi meta nối bằng middle-dot (`·`):**
   - `27` lỗi Hallmark Gate 67 ở [Cost.css:5-9,177-183](file:///home/toan/hasaki-orbit/web/src/components/Cost.css#L5-L9), [Overview.css:50-51](file:///home/toan/hasaki-orbit/web/src/pages/Overview.css#L50-L51), [Knowledge.css:413,492,676](file:///home/toan/hasaki-orbit/web/src/pages/Knowledge.css#L413), [Settings.css:201,704](file:///home/toan/hasaki-orbit/web/src/pages/Settings.css#L201), [Insights.css:258](file:///home/toan/hasaki-orbit/web/src/pages/Insights.css#L258), [ChatImportReview.tsx:130,152](file:///home/toan/hasaki-orbit/web/src/pages/ChatImportReview.tsx#L130).
   - `18` chuỗi meta ghép nhiều thông số bằng `·` tại [ProviderHandoff.tsx:254,260](file:///home/toan/hasaki-orbit/web/src/ProviderHandoff.tsx#L254), [AutonomyInsights.tsx:104](file:///home/toan/hasaki-orbit/web/src/pages/AutonomyInsights.tsx#L104), [Changes.tsx:124](file:///home/toan/hasaki-orbit/web/src/pages/Changes.tsx#L124).
   - **Đề xuất:** Đổi label sang sentence case untracked (`12px`–`12.5px`, `font-weight: 500/600`, `color: var(--muted)`). Tách chuỗi `·` dài thành grid/flex columns căn lề hoặc cặp `dl/dt/dd`.

4. **Inline `style={{ ... }}` lấn át design tokens & spacing:**
   - [Report.tsx](file:///home/toan/hasaki-orbit/web/src/pages/Report.tsx) có hơn **20** inline `style={{ marginTop: 4/6/10, ... }}`, [EvidenceGate.tsx](file:///home/toan/hasaki-orbit/web/src/EvidenceGate.tsx) có **14** inline style dùng pixel cứng (`gap: 8, marginTop: 4/6`). Việc này phá vỡ §1 của `ui-quality-standards.md` (*"Use gap on the owning flex/grid container rather than compensating margins on children"*).

---

## P2 — Gợi ý nâng cấp gu thẩm mỹ (Taste Skill — áp dụng cho Dashboard kỹ thuật)

Đánh giá tổng thể qua 4 trục của **Taste Skill** (đã lược bỏ các rule chỉ hợp landing page):

1. **Typography & Cỡ chữ:**
   - Hệ thống font `Be Vietnam Pro` + `tabular-nums` đã xử lý dấu tiếng Việt tốt. Tuy nhiên, `styles.css` có một số chỗ dùng chữ `11px`–`11.5px` (`--fs-xs: 11.5px`) kết hợp `uppercase` ở bảng/panel phụ, làm giảm độ dễ đọc trên màn hình mật độ cao. Gợi ý nâng floor chữ nội dung đọc được lên tối thiểu `12px` và tăng tương phản giữa tiêu đề section (`15px–16px`, semibold) với metadata (`12px–12.5px`, `--muted`).

2. **Nhịp spacing & mật độ hiển thị (Visual Density):**
   - `sloplint` ghi nhận `619` lần dùng spacing lệch thang 4px (`2px`, `6px`, `7px`, `10px`, `14px`) rải rác ở `RunView.css` (99), `WorkflowEditor.css` (57), `TraceExplorer.css` (54), `Knowledge.css` (45), `WorkItems.css` (42).
   - Nhiều trang dùng cùng một khoảng `gap: var(--sp-3)` / `var(--sp-4)` cho cả nhóm liên quan chặt lẫn nhóm tách biệt, khiến các khối thông tin thiếu nhịp (grouping vs separation). Áp dụng nguyên tắc `ui-quality-standards.md` §1: `8px` trong cùng nhóm control, `16px–24px` giữa các section độc lập.

3. **Bố cục Desktop (1440px) vs Mobile (390px):**
   - Các trang mới như [WorkflowEditor.css](file:///home/toan/hasaki-orbit/web/src/pages/WorkflowEditor.css#L782), [Insights.css](file:///home/toan/hasaki-orbit/web/src/pages/Insights.css#L484), [TraceExplorer.css](file:///home/toan/hasaki-orbit/web/src/pages/TraceExplorer.css#L607), [analytics.css](file:///home/toan/hasaki-orbit/web/src/pages/analytics/analytics.css#L408) đã dùng `@container` queries rất tốt khi co giãn cạnh sidebar/inspector.
   - Ngược lại, [Overview.css](file:///home/toan/hasaki-orbit/web/src/pages/Overview.css#L305), [Knowledge.css](file:///home/toan/hasaki-orbit/web/src/pages/Knowledge.css#L711), [Repositories.css](file:///home/toan/hasaki-orbit/web/src/pages/Repositories.css#L469), [Settings.css](file:///home/toan/hasaki-orbit/web/src/pages/Settings.css#L893), [WorkItems.css](file:///home/toan/hasaki-orbit/web/src/pages/WorkItems.css) vẫn phụ thuộc `@media` viewport (khi sidebar mở rộng ở `1280px` hoặc zoom `125%`, chiều rộng workspace thực tế hẹp hơn breakpoint viewport). Ở `390px`, các cụm header nhiều badge/button cần đảm bảo wrap gọn và không dùng `min(..., 100vw)` ở drawer/savebar.

4. **Disabled state & Feedback:**
   - [styles.css:322](file:///home/toan/hasaki-orbit/web/src/styles.css#L322) (`button:disabled`) mới chỉ giảm `opacity: 0.45`. Đối chiếu `ui-quality-standards.md` §12.5, các nút quan trọng bị disable nên có lý do hiển thị trực tiếp (`aria-describedby`) thay vì chỉ mờ đi.

---

## Đề xuất thứ tự 5 màn hình ưu tiên chạy `/unslop` trước

1. **`Overview` (`web/src/pages/Overview.tsx` + `Overview.css`)** — Màn hình đầu tiên người dùng thấy; đang chứa `.ov-hero` với radial/linear gradient + blob `::after`, kicker uppercase pill, và chỉ dùng `@media` thay vì `@container`. Dọn màn hình này sẽ định hình lại tone "quiet chrome" cho toàn app.
2. **`Knowledge` & `KnowledgeProposals` (`web/src/pages/Knowledge.tsx`, `KnowledgeProposals.tsx`, `Knowledge.css`)** — Mật độ badge/pill cao nhất repo (`31` vị trí), nhiều gradient card (`3` chỗ) và uppercase tracked labels (`3` chỗ). Chạy `/unslop` sẽ giảm nhiễu thị giác rõ rệt khi duyệt rule/proposal.
3. **`WorkItems` & `Report` (`web/src/pages/WorkItems.tsx`, `WorkItems.css`, `Report.tsx`)** — Còn emoji thô (`⏭`, `✅`, `❌`, `❓`, `✋`), nhiều card gradient và hơn 20 inline `style={{ ... }}` ở `Report.tsx`.
4. **`RunView` & `StepInspector` (`web/src/pages/RunView.tsx`, `RunView.css`, `StepInspector/*.tsx`)** — Màn hình cốt lõi dày đặc thông tin nhất (`99` findings ở `RunView.css`), có lỗi card lồng card (`ReexecuteDialog`, `TestFailurePanel`), `transition: width` ở progress bar, và `.inspector` dùng `overflow-x: hidden`.
5. **`Settings` & `AgentSettings` (`web/src/pages/Settings.tsx`, `Settings.css`, `AgentSettings.tsx`)** — Có 2 lỗi card lồng card (`agent-defaults-card`, `agent-profiles-card`), `.set-savebar` dùng `100vw` + `opacity: 0`, và `.agent-combobox input:focus` thiếu focus ring chuẩn.
