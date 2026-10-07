# HANDOFF PROMPT — Port tính năng từ `edxeth/pi-subagents` vào dự án này

> Cách dùng ở session mới: paste toàn bộ file này vào tin nhắn đầu tiên, HOẶC chỉ cần nói:
> "Đọc `docs/porting-edxeth-prompt.md` và bắt đầu theo mục 9."

---

## 0. Vai trò và nhiệm vụ của ngươi

Ngươi là agent tiếp tục công việc trên repo `@quandev104/pi-subagents` (thư mục làm việc hiện tại). Công việc: **port có chọn lọc các tính năng từ `references/edxeth-pi-subagents` vào dự án này**, theo roadmap ở mục 6. Việc phân tích và so sánh đã xong ở session trước — đừng phân tích lại từ đầu, chỉ xác minh đủ context rồi code.

Quy tắc bắt buộc: dùng `rg` (ripgrep), KHÔNG BAO GIỜ dùng `grep` binary trong lệnh shell.

---

## 1. Dự án hiện tại — bối cảnh kỹ thuật

Package `@quandev104/pi-subagents` v0.1.0 — extension cho Pi agent harness: runtime specialist subagent, mỗi agent chạy trong **process Pi độc lập** (không host AgentSession trong parent).

**Kiến trúc phân lớp bắt buộc** (dependency-cruiser enforce, xem `docs/ARCHITECTURE.md` + ADR 0006):

```
extension-src/pi-subagents/
├── shared/     primitives không phụ thuộc host (pure)
├── domain/     contracts, state transitions, policies (thuần, không I/O)
├── features/   UI surfaces cô lập, không import lẫn nhau
├── app/        manager, registries, delivery, worktree services
└── pi/         adapters Pi/process/socket/fs/Git; pi/index.ts là extension factory mỏng
```

Thứ tự phụ thuộc: `shared → domain → features → app → pi`. Domain KHÔNG import Pi package, filesystem, process. ARCH-007: rendering không làm I/O. ARCH-008: immutable snapshots tách runtime state khỏi UI.

**Điểm mạnh kiến trúc phải giữ nguyên (lợi thế so với edxeth):**
- Điều khiển child qua **Unix socket RPC có xác thực** (child protocol v2: `domain/child-protocol.ts`, `pi/child-rpc-client.ts`, `pi/child-bridge.ts`) — NDJSON, token, frame bound 1MiB, replay/dedup. KHÔNG chuyển sang poll session-file JSONL làm tín hiệu sống/progress (edxeth làm thế; ta tránh).
- Settlement do native `agent_settled` quyết định.
- Model admission (`pi/model-admission.ts`) TRƯỚC khi cấp run ID/slot/worktree/child.
- Durable registry + cold continuation (`docs/CONFIGURATION.md` §7): bootstrap.json + native JSONL, restore có xác thực PID, verified disposal.
- Worktree isolation giữ commit/branch + release tường minh (`app/worktree-service.ts`).
- Integration protocol v3 cho consumer (`pi-tasks`) — xem `docs/INTEGRATION.md`.
- Scoped inbox messaging (`app/message-service.ts`).

**Cơ chế hiện có quan trọng cho việc port:**
- `app/turn-policy.ts` — module pure về soft/grace/hard turn limit. **ĐÂY LÀ PATTERN MẪU** cho mọi policy mới: pure, không import, có bảng quyết định trong comment, test unit riêng.
- `domain/ui-view.ts` — focus state có sẵn `context: { usedTokens, windowTokens }` từ child (dữ liệu cho context warnings đã tồn tại).
- `app/agent-manager.ts` — admission, concurrency budget (`maxConcurrent`), queueing, delivery.
- `pi/tools.ts` — `Agent` (params: `prompt`, `description`, `subagent_type`, `model`, `thinking`, `max_turns`, `run_in_background`, `resume`), `get_subagent_result` (có `wait`), `steer_subagent`, inbox tools.
- `domain/config.ts` + `domain/agent-definition.ts` — settings JSON (`maxConcurrent`, `defaultMaxTurns`, `graceTurns`, `backgroundByDefault`, `worktreeIsolation`, `rememberAgents`, `strictAgentFiles`, `fallbackSubagent`, `agentPanel`) và frontmatter definition (`name`, `description`, `tools`, `model`, `thinking`, `max_turns`, `prompt_mode`, `run_in_background`, `isolation`, `enabled`).
- Definitions resolve: `bundled < ~/.pi/agent/agents/*.md < .agents/agents/*.md < .pi/agents/*.md`; load ở `session_start`, admitted run giữ snapshot.
- Children: set `PI_SUBAGENTS_CHILD=1`, không load parent orchestration extension, không nhận `Agent`/`get_subagent_result`/`steer_subagent`.
- Terminal layout: `pi/herdr-pane-layout.ts`, `pi/tmux-pane-layout.ts`, `pi/terminal-pane-layout.ts` — Main trái full-height, cột phải tối đa 3 child/cột.

**Tooling & commands:**
- Node >=22.19, Pi peers `>=1.0.4 <1.1.0` (peer packages nằm trong `node_modules/@earendil-works/...`).
- Format: biome, **tab indent, double quotes, semicolons, trailing commas, lineWidth 120**. Biome chỉ check `extension-src`, `test`, root `.ts` (đã exclude `references`).
- Test: vitest, cấu trúc `test/{unit,integration,render,fixtures,helpers}`.
- `npm run check` = typecheck + lint + depcruise + build/tests + package smoke. **Phải pass trước khi kết thúc mỗi feature.**
- `npm run dev:pi` để chạy thử extension thật.
- Yêu cầu đặc thù (từ README): lifecycle/terminal changes cần isolated native-process smokes ngoài unit test; UI changes cần quan sát trong Pi TUI thật. Unit test một mình không đủ.

**Docs phải cập nhật khi thêm feature:** `README.md`, `docs/CONFIGURATION.md` (schema/settings/frontmatter), `docs/ARCHITECTURE.md` (nếu đổi kiến trúc), `CHANGELOG.md`, đôi khi `docs/INTEGRATION.md`. ADRs nằm ở `docs/decisions/`.

---

## 2. References — nguồn để port

- `references/edxeth-pi-subagents` — clone của https://github.com/edxeth/pi-subagents, branch `main` @ commit `cf6dbf4`, version v2.9.2. ~26.000 LOC, src phẳng không phân lớp. Đây là NGUỒN DUY NHẤT để port.
- `references/pi-subagents` (cũ) — là `tintinweb/pi-subagents` v0.19.0, **dòng hoàn toàn khác, KHÔNG dùng**.
- `references/my-pi-setup`, `references/pi-subtask`, `references/pi-task` — không liên quan việc này.

edxeth là fork của `HazAT/pi-interactive-subagents`, điều khiển child bằng watch session-file + mux pane management (HerdR/cmux/tmux/zellij/WezTerm). Cấu trúc source tham chiếu nhanh:
- `src/runtime/` — timeout-budget, timeout-wrap-up, timeout-restart, batch-classifier, outstanding-work, fork-session-manager, orchestrator-{config,controller,policy,prompt}, result-router, provider-error-recovery
- `src/tools/` — context-reminders, timeout-reminders, subagent-done, caller-ping, set-tab-title, subagent-tools
- `src/launch/` — child-launch-plan, env, env-capsule, child-env, skills, skill-visibility, task-expansion, seed-child-session, context-boundary, resume
- `src/agents/definitions.ts` — parse frontmatter ~40 trường
- `src/session/` — timeout-sidecar, exit-sidecar, session-files, child-session-storage
- `src/mux/` — zellij-{placement,policy,runtime,anchor-state}, herdr-*, cmux-surfaces
- `src/vf/` — toàn bộ LLM-as-a-verifier (best-of-N)

Chi tiết hành vi đầy đủ của edxeth: đọc `references/edxeth-pi-subagents/README.md` (1085 dòng, rất chi tiết — mô tả chính xác semantic từng field).

---

## 3. Quyết định đã chốt — KHÔNG bàn lại

1. **KHÔNG hỗ trợ nested swarm / spawn lồng nhau. Vĩnh viễn.** Đã ghi vào `docs/decisions/0003-deliberate-feature-scope.md` (mục "Tái khẳng định: không nested swarm"). Đã rà soát cơ chế của edxeth (`spawning`/`spawn-depth`/`spawn-width`/`visible-to`) và từ chối. KHÔNG port các field này. Nếu thấy cần mở lại thì phải viết ADR mới thay thế ADR 0003 — không tự ý làm.
2. Giữ hai-layer design: parent → specialists, phẳng. Nhu cầu phân rã sâu hơn thuộc consumer (`pi-tasks`) hoặc parent phối hợp nhiều specialist song song (đã có concurrency queue + scoped inbox).
3. Giữ Unix-socket RPC làm kênh điều khiển; không thay bằng JSONL polling.

---

## 4. Tổng kết so sánh (đã làm ở session trước)

**Bên mình mạnh hơn (giữ, không đụng):** child control RPC có xác thực, model admission trước cấp tài nguyên, worktree isolation giữ commit, integration v3 + inbox scoped, durable registry/cold continuation, kiến trúc phân lớp + dependency-cruiser.

**edxeth mạnh hơn (nguồn port):** time limits, context warnings, sync/async barrier semantics, fork context, orchestrator mode, frontmatter dày, mux backends thêm, LLM-as-a-verifier, nhiều chi tiết UX nhỏ.

**KHÔNG port (đã loại):**
- `task-expansion: shell` — chạy shell từ task text trước launch; mâu thuẫn tư thế bảo mật (injection qua agent file).
- Poll session-file làm tín hiệu sống — chỉ học ý tưởng idle-detection, triển khai trên RPC events.
- Spawn lồng (mục 3).
- Cấu trúc code phẳng của edxeth — luôn viết lại theo layering bên mình.

---

## 5. Nguyên tắc port bắt buộc

1. **Viết lại theo layering**, không copy file nguyên văn: policy thuần → `domain/` hoặc `app/`; orchestration/watcher → `app/`; tương tác process/socket/fs → `pi/`; UI → `features/`. Tuân theo pattern module pure như `app/turn-policy.ts` (không import, bảng quyết định trong doc comment, test unit riêng).
2. **Naming theo convention bên mình** (snake_case frontmatter, camelCase settings), không theo tên field của edxeth nếu trùng concept đã có (ví dụ edxeth `system-prompt: append|replace` ≈ bên mình `prompt_mode` — giữ `prompt_mode`).
3. Mỗi feature: implement + unit tests + cập nhật docs (README/CONFIGURATION/CHANGELOG) + `npm run check` pass. Lifecycle/terminal: thêm smoke isolated native-process. UI: xác nhận trong Pi TUI thật.
4. Không thêm dependency ngoài nếu tránh được. Peer versions giữ nguyên.
5. Tương thích protocol: child protocol v2 và integration v3 là versioned — nếu thay đổi frame/fields thì nâng version và giữ tương thích ngược theo cách đã làm.
6. Settings mới phải có: default an toàn (tắt/opt-in nếu nguy cơ token cost), sanitize + clamp như các setting hiện có trong `domain/config.ts`, ghi bảng setting vào `docs/CONFIGURATION.md` §5.
7. Frontmatter mới: parse trong definition loading, strict/lenient mode theo `strictAgentFiles` hiện hành.

---

## 6. Roadmap chi tiết (thứ tự thực hiện)

### Giai đoạn 1 — nhỏ, khớp kiến trúc sẵn có

**1.1 Time budgets: `timeout` + `idle-timeout` (hard limits)**
- Semantics (học từ `src/runtime/timeout-budget.ts`): `timeout` = giây cho toàn run (bắt đầu từ lúc launch); `idle-timeout` = giây không có output (message/tool-result của child; steer không tính). Chỉ output của child tính; min useful = vài chục giây. Giá trị phải là số nguyên dương, sai format → fail load (không phải "no limit").
- Frontmatter + per-invocation override qua `Agent` param + settings default (opt-in, mặc định không giới hạn).
- Implement: `domain/time-policy.ts` (pure, mirror `turn-policy.ts`), watcher ở `app/` subscribe qua backend events có sẵn (không poll file), hard-stop qua lệnh abort + launcher terminate hiện có. Kết quả về parent phải ghi rõ child bị dừng vì budget nào, partial work có thể incomplete, và resume áp lại cùng limit.
- Tham khảo thêm `src/session/timeout-sidecar.ts`, `src/runtime/timeout-restart.ts` của edxeth (chỉ để hiểu, không copy).
- Status: VERIFIED — main `npm run check` PASS (typecheck, biome 113 files, depcruise 78 modules/281 deps no violations, build, 42 test files/479 tests, package smoke) + standalone native smoke PASS 5/5 (wall/idle budget hard-stop, steer không reset idle, hung tool kill Pi+subprocess, frozen SIGSTOP hard-kill với session preserved, tampered receipt, survivors=[]); chưa claim live-model/Pi TUI. Roadmap 1.2+ vẫn pending.

**1.1b Full-result channel: result artifact + get_subagent_result đọc lại được (fix correctness — làm TRƯỚC 1.2)**

- Vấn đề (đã chẩn đoán xong ở session trước, không phân tích lại): kết quả settled bị cắt 3 tầng. (1) `pi/child-bridge.ts` `MAX_TEXT_CHARS = 8_192` áp cho bản `record.result` — frame-bound bị lạm dụng thành storage policy; registry/integration snapshot lưu bản cắt. (2) Notification chỉ preview 400 ký tự (`app/delivery-service.ts` `previewOf`). (3) `get_subagent_result` one-shot: `resultConsumed` → error trỏ vào notification — bản KÉM NHẤT — làm "authoritative copy" (`app/agent-manager.ts` ~991). `resultTruncated`/`resultOriginalLength` có sẵn trong `ChildOutcome` (`domain/child-protocol.ts` ~53) nhưng không layer nào tiêu thụ. Sau settlement child đã đóng (steer chỉ chạy lúc queued/running) → đường duy nhất là `resume`: process mới + nạp lại toàn bộ JSONL. Triệu chứng: "bị cắt xong lại bắt con trả lại kết quả".
- Nguyên tắc (học OMP/tintinweb, thích ứng chứ không copy): bản inline được cắt để tiết kiệm context cha, NHƯNG luôn tồn tại bản đầy đủ ở file có địa chỉ ổn định, đọc lại vô hạn; "consume" chỉ suppress notification trùng, không khóa quyền đọc. Không import: `agent://` scheme (đặc thù host OMP; cha đã có `read` phân trang), tombstone/in-memory record (durable registry hiện có mạnh hơn), structured sidecar (ngoài ADR 0003).
- Thay đổi:
	1. `pi/child-bridge.ts` — tại `settleActiveRun()`: ghi FULL assistant text ra `<sessionDir>/result.md` trước khi trả outcome. Child đã biết `sessionDir` cả hai đường chạy: bootstrap field (`domain/child-protocol.ts` `Bootstrap.sessionDir`), headless resolve ở `pi/headless-child.ts` ~107, interactive nhận `--session-dir` ở `pi/process-backend.ts` ~206. `ChildOutcome` thêm `resultFile?: string` — additive, giữ child protocol v2 theo precedent đã làm. Dir đã 0700.
	2. `domain/agent-run.ts` — thêm `resultFile?`, `resultTruncated?`, `resultOriginalLength?`. `app/run-registry.ts` và `domain/integration-protocol.ts` persist/truyền additive (integration v3 giữ version, additive field).
	3. `app/agent-manager.ts` — `getResult`: bỏ one-shot error; nếu `resultFile` tồn tại thì phần result của `formatRecord` đọc từ file (guard: file lỗi/thiếu → fallback `record.result` + ghi chú rõ); `resultConsumed` chỉ còn tác dụng suppress notification. `formatRecord` in truncation khi có: `Result truncated at 8192/N chars — full: <path>`.
	4. `app/delivery-service.ts` — notification `details` thêm `resultFile` (+ `durationMs`, tổng tokens nếu sẵn); preview vẫn 400. **Không viết renderer: xóa `features/notifications`** (cùng render tests) — `content` plain-text có cấu trúc là presentation chuẩn: dòng 1 `Teammate <id> finished|failed|stopped (<type>, <duration>)` (stopped thêm budget), body preview, dòng cuối `full result: <path>`. Không icon/ANSI/box. `SUBAGENT_NOTIFICATION_TYPE` + schema `details` trở thành **renderer contract xuất khẩu** cho pi-style (đăng ký renderer theo customType nếu load; không có thì content hiển thị nguyên văn — đúng hình Claude Code). Ghi contract này vào `docs/INTEGRATION.md`.
	5. `pi/tools.ts` — cập nhật description `get_subagent_result`: full result, đọc lại được, kèm path để cha `read` phân trang khi dài.
- Không đổi: frame bound 1 MiB, `MAX_TEXT_CHARS` 8K cho bản inline, settlement authority (`agent_settled`), delivery guard, ownership/quarantine, ADR 0004/0005.
- Tests: unit cho `formatRecord` (in truncation) + `getResult` (re-read, fallback khi file hỏng); integration settle → tồn tại `result.md` → `getResult` hai lần đều nhận full. Không đụng lifecycle/terminal nên không bắt buộc smoke native-process (chạy thêm smoke nhẹ nếu muốn chắc).
- Docs: `docs/ARCHITECTURE.md` §13–14, `docs/INTEGRATION.md` (snapshot field `resultFile`), `CHANGELOG.md` Unreleased.
- Lý do ưu tiên trước 1.2: mọi mục 1.2+ (context warnings, barrier, fork-context, verifier) đều tăng lượng thông tin con→cha — kênh thu hoạch đang rò rỉ thì feature càng nhiều, lỗi càng đắt.

- Ghi chú (2026-10-08): [ADR 0007](./decisions/0007-session-bound-agent-teams.md) chọn 1.1b làm nền — teardown graceful+preserve và idle-notification kèm final answer đều tiêu thụ kênh full-result này. Teams pivot (named peers, mailbox P2P một-file-một-message + HMAC, task board có dependencies, một tool `send_message`) xây sau 1.1b và ăn theo đúng artifact `result.md`.

**1.2 Context warnings 3-stage**
- Semantics (học từ README edxeth mục context-warn + `src/tools/context-reminders.ts`): `context-warn-threshold` (off mặc định, 1–99%), `context-warn-step` (mặc định 5%). Vượt ngưỡng → gửi steer cảnh báo kèm "X/Y tokens (Z%)"; 3 cảnh báo càng gấp; child dừng ở cảnh báo cuối là wrap-up hợp lệ — annotate result cho parent ("đừng resume, spawn agent mới; báo cáo ngắn là đúng"), chặn resume kết quả đã warn ở cảnh báo cuối (resume thường vẫn được phép).
- Dữ liệu đã có: `context.usedTokens/windowTokens` trong focus state (`domain/ui-view.ts`). Watcher ở `app/` theo dõi mỗi refresh, track ngưỡng đã bắn, tự reset nếu usage tụt xuống (sau compaction).
- Thêm `report-context-usage` (mặc định true) — dòng context usage trong result về parent.

**1.3 Sync/async batch barrier + parent-turn stop sau async launch**
- Semantics (học từ `src/runtime/batch-classifier.ts` + README mục "Launching and waiting"): nếu MỘT call sync/blocking trong một tool batch → cả batch là barrier, parent chờ tất cả; batch thuần async → parent nhận started results và **turn parent kết thúc sau batch đó** (tránh parent tự làm tiếp đua với child) — trừ khi parent không thể nhận steer sau này (headless/-p) thì vẫn chờ. Env opt-out kiểu `PI_SUBAGENTS_DISABLE_COORDINATOR_ONLY_TURN` nếu cần.
- Đối chiếu hành vi hiện tại của `Agent` foreground + `get_subagent_result(wait)` trước khi sửa.

**1.4 UX nhỏ (làm rải rác kèm các mục trên)**
- Space-flip `enabled` trong Agents Hub → viết lại agent file (học `src/tools/overlay/` của edxeth; bên mình sửa ở `features/agent-panel` + `app/agent-registry`).
- Pane/session title dạng `[agent] Title` cho HerdR/tmux panes.
- Near-miss warning cho tool name trong definition (`edti`→`edit`) — warning không chặn launch.

### Giai đoạn 2 — tính năng lớn, cần thiết kế kỹ trước khi code

**2.1 Fork session mode (`inherit_context`)**
- Hiện `Agent` đang reject `inherit_context`; mở lại thành `session_mode: lineage-only (mặc định) | fork | standalone` hoặc tương đương theo convention mình.
- Học từ: `src/runtime/fork-session-manager.ts`, `src/launch/seed-child-session.ts`, `src/launch/context-boundary.ts`. Cơ chế: seed session JSONL child từ parent transcript + system-prompt note + hidden custom message `<subagent-boundary>` cuối transcript ("messages cũ là background; user message kế tiếp là task của child") — chống child "diễn vai parent". Context window mismatch: để native compaction của child tự trim theo model child — không config budget thủ công.
- Tích hợp vào bootstrap.json hiện có; fork + resume + restore phải hoạt động nhất quán.

**2.2 Orchestrator mode**
- Semantics: toggle per-conversation (giữ conversation cũ hoặc mở mới); restrict parent toolset xuống chỉ subagent tools (+stop/resume); THAY system prompt bằng orchestrator role (decompose → delegate → synthesize), vẫn respect APPEND_SYSTEM; nhớ mode theo conversation; env `PI_ORCHESTRATOR_MODE=1` default cho conversation mới.
- Tham khảo: `src/runtime/orchestrator-{config,controller,policy,prompt}.ts` — prompt của họ rất chỉn chu (bảng khi nào resume vs spawn fresh, ví dụ task tốt/xấu) — viết lại theo giọng của mình.

**2.3 Frontmatter mở rộng chọn lọc**
- `env` (KEY=VALUE block, expand `~/`, riêng `PI_CODING_AGENT_DIR` resolve trước launch) + `deny-env` (danh sách tên, wildcard `*`, không lọc giá trị do `env` set) — học `src/launch/{env,env-capsule,child-env}.ts`.
- `extensions: all|none|allowlist` cho child — học `src/launch/extensions.ts` (kể cả managed npm reuse).
- `skills: all|none|allowlist` + visibility annotation `=auto`/`=manual` + `inject-skills` (nhúng SKILL.md vào task artifact) — học `src/launch/{skills,skill-visibility}.ts`.
- `no-session` (ephemeral child, xóa session sau completion).
- `allowed-models` + `allow-model-override` (mặc định cho phép per-launch model choice; opt-out để pin) — tinh hơn rule "pin definition luôn thắng" hiện tại, giữ tương thích với model admission.

**2.4 `subagent_done` tool cho child**
- Manual-lifecycle child gọi tool này kèm final message → native settlement; tự ẩn khi dùng auto lifecycle. Học `src/tools/subagent-done.ts`.

### Giai đoạn 3 — flagship

**3.1 LLM-as-a-verifier (best-of-N)**
- N-candidate chạy song song trong git worktree riêng (nền `app/worktree-service.ts` đã có), verifier LLM chấm theo criteria (built-in `generic`/`code-change`/`research` hoặc file), winner stage vào working tree (không commit), detached supervisor sống qua parent reload, delivery cho launching session/ancestor.
- Phụ thuộc backend OpenAI-compatible có `logprobs` — cần preflight call trước khi trả tiền. Tham khảo toàn bộ `src/vf/`.

**3.2 (Tùy chọn) Zellij adapter + placement policy** — học `src/mux/zellij-*.ts`; pattern min-size (50 cols/12 rows check trước split) cũng đáng áp ngược cho layout HerdR/tmux hiện tại.

---

## 7. Definition of Done cho MỖI feature

- [ ] Code theo layering, depcruise pass, biome pass, typecheck pass
- [ ] Unit tests cho policy pure + integration tests cho luồng manager/backend
- [ ] Frontmatter/settings mới: sanitize + clamp + strict mode behavior + bảng docs
- [ ] `README.md` + `docs/CONFIGURATION.md` + `CHANGELOG.md` cập nhật (viết theo style docs hiện có — tiếng Anh, terse, bảng)
- [ ] `npm run check` pass toàn bộ
- [ ] Smoke native-process nếu đụng lifecycle/terminal; quan sát TUI thật nếu đụng UI
- [ ] Không phá tương thích child protocol v2 / integration v3 (hoặc nâng version có chủ đích)

---

## 8. Gợi ý quy trình làm việc từng phiên

1. Chọn đúng MỘT mục roadmap, không trộn.
2. Đọc kỹ file đối ứng bên edxeth (mục 6 chỉ đường) + đọc module tương ứng bên mình.
3. Thiết kế nhỏ (file mới/sửa nào, layer nào) → implement → test → docs → `npm run check`.
4. Cập nhật tiến độ: đánh dấu mục đang làm trong file này (thêm dòng "Status" dưới mục) + CHANGELOG `Unreleased`.

---

## 9. Việc bắt đầu ngay (phiên đầu tiên)

**Mục 1.1 — Time budgets (`timeout` + `idle-timeout`).**

Bước đề xuất:
1. Đọc `extension-src/pi-subagents/app/turn-policy.ts` (pattern mẫu), `domain/agent-definition.ts`, `domain/config.ts`, `app/agent-manager.ts`, `domain/agent-run.ts`, `pi/process-backend.ts` (event flow child → parent), `domain/child-protocol.ts` (events có sẵn để detect activity).
2. Đọc `references/edxeth-pi-subagents/src/runtime/timeout-budget.ts` + README mục "Stop a runaway child with time limits" (dòng ~250–420) để chốt semantics chính xác.
3. Viết `domain/time-policy.ts` (pure) + unit tests theo pattern turn-policy.
4. Mở rộng `domain/agent-definition.ts` (frontmatter `timeout`, `idle-timeout`), `domain/config.ts` (defaults off), `pi/tools.ts` (Agent params) — theo nguyên tắc mục 5.6–5.7.
5. Watcher ở `app/` (timer + activity từ backend events; không poll file), hard-stop qua abort/terminate có sẵn, result format ghi rõ budget nào hết, resume áp lại limit.
6. Docs + CHANGELOG + `npm run check`.

Mốc đầu tiên của phiên: báo cáo thiết kế ngắn (file nào đổi, layer nào) trước khi viết code lớn.
