# Comprehensive implementation plan: teammate shutdown và cross-session messaging

> Trạng thái: kế hoạch triển khai, chưa phải hành vi runtime hiện tại.
> Ngôn ngữ normative: **MUST** là invariant bắt buộc; **SHOULD** là mặc định có thể điều chỉnh nếu ghi lại lý do.
> Phạm vi: package `@quandev104/pi-teams`; không sửa code trong `references/`.

## 1. Mục tiêu và quyết định kiến trúc

Update gồm hai capability độc lập nhưng dùng chung identity/routing boundary:

1. Thay `retire` bằng `shutdown`: stop được teammate đang busy, xác nhận execution đã đóng, rồi xóa membership. Không duy trì trạng thái `retired` trong lifecycle mới.
2. Thêm local cross-session messaging: các Pi session độc lập discover và nhắn nhau mà không trở thành teammate hoặc có quyền quản lý lifecycle của nhau.

Giữ nguyên các nguyên tắc:

- Teammate thực thi trong Pi process/session riêng; không nhúng child AgentSession vào parent.
- Danh tính teammate, native conversation/context, assignment run và task là các entity khác nhau.
- Lead sở hữu execution của teammate do mình tạo; peer không sở hữu nhau.
- Cleanup phải được kiểm chứng; không báo shutdown thành công khi child có thể vẫn sống.
- Run history, native transcript và task history không bị xóa cùng membership.
- Không tự động coi assignment settlement hoặc shutdown là task completion.
- Không phụ thuộc Herdr/tmux để messaging hoạt động.

### 1.1 Non-goals cho increment đầu

- Cross-machine, cloud relay, remote discovery.
- Shared task board hoặc ownership task giữa các team.
- Đọc transcript/thinking của peer, hoặc tính năng `talk_latest`.
- Tự phục hồi hoặc spawn session đã đóng chỉ để nhận message.
- Peer được stop/shutdown/reset/release một session khác.
- Tự động giao việc mới cho peer như cho subordinate.
- Shutdown handshake có quyền từ chối của teammate.
- Một lần rewrite toàn bộ transport/backend hiện có.

## 2. Baseline đã đối chiếu với repository

| Thành phần hiện tại | Vị trí chính | Hệ quả cho update |
| --- | --- | --- |
| Team roster và identity name/type/color | `extension-src/pi-teams/domain/team.ts` | Thêm immutable membership ID; bỏ retired sau migration |
| Retained execution, context generation | `extension-src/pi-teams/app/teammate-runtime.ts` | Tách membership incarnation khỏi context generation |
| Admission, stop, release, retire, finalize | `extension-src/pi-teams/app/agent-manager.ts` | Tích hợp shutdown không deadlock hoặc resurrection |
| Team persistence/lifecycle | `extension-src/pi-teams/app/team-service.ts` | Archive/remove identity theo ID, không chỉ tên |
| Mailbox contracts và delivery | `domain/mailbox.ts`, `domain/delivery.ts`, `app/mailbox-service.ts`, `app/delivery-service.ts` | Reuse phần phù hợp; không nới trust boundary của team key |
| Host/child messaging | `pi/child-mailbox.ts`, `pi/child-bridge.ts`, `pi/delivery-host.ts`, `pi/teammate-routing.ts` | Chặn message mới trong shutdown; delivery theo incarnation |
| Task reservations và attempts | `app/task-board-service.ts`, `app/task-execution-service.ts` | Settle attempt trước khi trả claim; xử lý late event |
| Task automation | `app/task-automation-service.ts` | Không tự spawn lại identity vừa shutdown |
| Tools, commands và composition | `pi/tools.ts`, `pi/commands.ts`, `pi/index.ts`, `pi/teams-host.ts` | Thay public API, đăng ký peer tools/host adapter |
| Native process/backend | `pi/process-backend.ts`, `pi/child-guard.ts`, `pi/child-endpoint.ts` | Reuse abort/verified disposal/force-kill |
| UI snapshot/contracts | `app/ui-snapshot.ts`, `domain/ui-view.ts`, `features/` | Live rows khác historical rows; thêm shutdown progress |
| Documentation/skills | `README.md`, `docs/`, `skills/team-lead/SKILL.md` | Cập nhật guidance và compatibility |

Các path rút gọn trong bảng nằm dưới `extension-src/pi-teams/` nếu không ghi đầy đủ.

Hiện tại `retireTeammate` chỉ nhận settled teammate. Terminal run chuyển teammate sang idle nếu runtime còn handle, nếu không thì released. `contextGeneration` hiện có không đủ để phân biệt hai danh tính khác nhau tái sử dụng cùng tên.

Hiện tại task board đã chặn release claim khi còn running attempt; MUST giữ invariant này thay vì bypass bằng cách sửa owner trực tiếp.

## 3. Target architecture và ownership

```text
Pi session / host composition
├── Team management
│   ├── TeamService: roster + membership persistence
│   ├── AgentManager: admission / runs / shutdown orchestration
│   └── TeammateRuntime: live resources + operation guards
├── Messaging
│   ├── Team route: teamId + membershipId
│   ├── Peer route: peerSessionId + runtime incarnation
│   ├── Discovery registry
│   ├── Inbound policy
│   └── Mailbox / receipt / safe delivery
└── Tasks
    ├── TaskBoardService: specs / claims / history
    └── TaskExecutionService: reservations / attempts / reconciliation
```

### 3.1 Permission matrix

| Hành động | Lead → owned teammate | Independent peer → session |
| --- | --- | --- |
| Discover / send message | Có, theo team routing | Có, theo scope và inbound policy |
| Stop / release / shutdown | Có | Không |
| Reset context | Có | Không |
| Shared task board | Trong team | Không |
| Read private transcript/thinking | Không cấp bởi messaging | Không |
| Message được coi là user consent | Không | Không |

Peer message có thể đề nghị trao đổi/thực hiện một việc, nhưng không tạo quyền điều khiển hoặc bỏ qua permission của receiver. Việc bị từ chối trong session A không được relay sang B để lách policy.

### 3.2 Module boundaries

- Domain giữ contracts thuần; không import filesystem, Pi SDK hoặc transport.
- App services xử lý policy/state transitions qua interfaces.
- Host adapters xử lý SDK injection, files/sockets, clocks, process evidence và UI.
- Đề xuất thêm `domain/peer.ts`, `domain/peer-message.ts`, `app/peer-discovery-service.ts`, `app/peer-messaging-service.ts`, `pi/peer-host.ts`, `pi/peer-tools.ts`.
- Tên file mới là đề xuất; điều chỉnh để khớp dependency-cruiser và style khi implementation bắt đầu.
- Chỉ extract primitive mailbox/auth thực sự dùng chung; giữ nguyên team envelope nếu không cần migration. Không tạo framework transport tổng quát trước khi có nhu cầu.

## 4. Identity và addressing

### 4.1 Teammate identity

Mỗi membership mới có immutable `membershipId`, ngoài `teamId`, `name`, `type`, `color`.

- Tên là alias hiển thị và input tiện dụng, không phải durable authorization key.
- Name resolution phải xảy ra trước admission và bind vào membership ID.
- Membership ID mới khi tên được dùng lại sau shutdown.
- Context generation tăng khi thay context trong cùng membership; không thay thế membership ID.
- Run/task attempt/message mới SHOULD lưu identity ID để history không nhầm người cùng tên.
- Historical row có thể giữ tên/màu cũ; không được suy ra đó là member hiện tại.

Ví dụ:

```text
@alice / membership M1 / context C1 → shutdown
@alice / membership M2 / context C1 → teammate mới
```

Message, callback, resume request và reservation của M1 MUST NOT điều khiển M2.

### 4.2 Peer identity

Phân biệt native session ID với active runtime:

- `peerSessionId`: ID ổn định của conversation/session, không lấy PID hoặc display name làm ID.
- `runtimeId`: incarnation của lần mở runtime hiện tại.
- Hai runtime vô tình cùng mở một native session không được tự chọn ngẫu nhiên; báo ambiguity hoặc route bằng full runtime address.
- Tên cho phép trùng giữa project; resolution mơ hồ phải yêu cầu chọn ID.
- Routing dùng namespace rõ ràng: teammate address khác peer address.
- Mail tồn từ runtime cũ không replay vào runtime mới mặc định.

## 5. Lifecycle mới

### 5.1 Stable states và operation state

Stable teammate states: `busy | idle | released`.

Bổ sung transient operation marker `shutdownRequested`/`operation: shutting_down` trong runtime và durable recovery record. Đây không phải stable retired state. Public status MUST hiển thị operation để không thể hiểu một idle member đang shutdown là có thể nhận việc.

`availability`, `recoveryError`, `contextAvailable` tiếp tục là các chiều riêng.

```text
spawn → busy ⇄ idle
          │      └─ release → released → assignment → busy
          │                       │
          └──────── shutdown ─────┘
                         ↓
                 membership removed
```

### 5.2 Operation contracts

| Operation | Preconditions | Kết quả |
| --- | --- | --- |
| Assignment | Member tồn tại, không shutting down, không busy, context policy hợp lệ | Tạo run mới; busy |
| Stop | Run active hoặc queued | Hủy assignment; giữ membership; idle/released tùy tài nguyên được xác nhận |
| Release | Member settled, không shutdown operation cạnh tranh | Đóng retained context; released; giữ claim như hiện tại |
| Shutdown | Member tồn tại ở bất kỳ stable state nào | Chặn admission, stop/cancel, cleanup, trả claim hợp lệ, xóa membership |
| Fresh | Idle context có ownership kiểm chứng hoặc released member | Context mới, cùng membership; mailbox cũ được archive |

`context: continue` vẫn yêu cầu verified idle live context. Không âm thầm cold-resume.

### 5.3 Shutdown algorithm

1. Authorize lead against current team ownership; resolve name thành membership ID.
2. Dưới teammate lock, atomically đánh dấu shutdown intent và ghi operation ID; admission/message routes bắt đầu từ chối work mới.
3. Invalidate deferred mailbox admissions, queued assignment admission và task reservations chưa spawn cho membership đó.
4. Cancel queued run hoặc request stop cho active run. Không đợi member tự đồng ý.
5. Await settlement/finalization có deadline. Nếu child không dừng, reuse verified ownership → bounded terminate/kill. Không kill PID chỉ dựa vào số PID.
6. Dispose retained context, endpoint/pane/watchers; xác nhận resource đã đóng. Đóng pane không được coi là bằng chứng process đã thoát.
7. Reconcile task attempt outcome. Completed run thắng race vẫn được giữ completed; không sửa thành stopped chỉ vì shutdown đang diễn ra.
8. Với task chưa terminal thuộc membership, trả claim về pending sau khi không còn execution active. Không complete/cancel task.
9. Archive/discard pending team mailbox theo membership ID với reason `shutdown`; không replay.
10. Archive identity metadata phục vụ history; remove live roster/runtime entry sau khi các bước bắt buộc thành công.
11. Emit một shutdown-completed event và receipt; dọn discovery registration của child nếu có.

**Locking:** không giữ teammate lock trong khi await một callback/finalizer cần cùng lock. Ghi intent dưới lock, chạy phần asynchronous qua operation token, revalidate membership/operation ID trước commit. Cần viết lock-order contract trước implementation.

### 5.4 Failure, retry và idempotency

- Cleanup thất bại: giữ operation/recovery record, chặn reuse tên, trả phase/error cụ thể.
- Child đã đóng nhưng claim cleanup thất bại: giữ minimal recovery identity, retry từ phase chưa hoàn tất; không spawn child mới.
- Force-kill không xác nhận được: không xóa ownership receipt hoặc membership.
- Concurrent shutdown cùng membership join cùng operation hoặc trả operation đang chạy; không chạy cleanup hai lần.
- Retry bằng operation ID/membership ID là idempotent.
- Gọi shutdown bằng tên lần sau là một request mới: nếu tên đã được tái sử dụng, phải trả đúng membership mới qua resolution và confirmation context; không coi đó là retry cũ.
- Completion/event đến muộn chỉ được cập nhật historical run của membership gốc, không recreate roster entry hoặc setState vào tên hiện tại.
- Restart/session teardown không adopt foreign/live runs. Shutdown intent chưa xong phải dùng cơ chế recovery ownership hiện có; không tự kill resource chưa xác minh.

### 5.5 Tasks, automation, resume và worktrees

- Chỉ dùng board service/lock để đổi claim, không sửa JSON ngoài service.
- Running attempt phải được settled hoặc có recovery error trước khi release claim.
- Với `in_review`: giữ outcome và attempt history, chuyển pending và bỏ owner sau khi xác nhận không active attempt; cập nhật validation/tests rõ ràng cho transition mới nếu hiện tại chưa hỗ trợ.
- Completed/cancelled tasks giữ nguyên.
- Plan có tên member vừa shutdown không được tự động tạo lại danh tính bởi auto-cascade. Vô hiệu hóa/mark unresolved plan đã bind membership đó; explicit manual execution có thể resolve sang member mới.
- Cancel reservation đã tạo nhưng chưa bind/spawn bằng precondition trên membership ID và operation state; không xóa reservation của một execution còn sống.
- Cold resume run của membership đã shutdown không được tái sinh danh tính cũ. Bản đầu: từ chối named resume đó; user tạo member mới và cung cấp context cần thiết. Giữ transcript cho đọc/audit.
- Giữ nguyên cold resume hợp lệ của released member còn tồn tại.
- Shutdown không tự xóa branch/worktree hoặc thay đổi chưa được preserve. Giữ cleanup worktree explicit theo contract hiện tại.

## 6. Local cross-session discovery

### 6.1 Metadata công bố

```ts
interface PeerAdvertisement {
  protocolVersion: number;
  peerSessionId: string;
  runtimeId: string;
  displayName: string;
  projectId: string;
  worktreePath?: string;
  status: "idle" | "busy" | "unavailable";
  activity?: string;
  updatedAt: number;
  capabilities: string[];
}
```

Schema cuối cùng cần bounded fields, strict parsing và compatibility tests. `activity` là mô tả ngắn do user/agent set, không tự trích thinking/transcript. Không publish environment, credentials, nội dung file hay spawn prompt đầy đủ.

### 6.2 Discovery scope

- Mặc định: cùng OS user và cùng repository/project.
- Git project: canonical common Git directory để các worktree cùng repo tìm thấy nhau.
- Non-Git project: canonical explicit project root hoặc cwd được chuẩn hóa; không tự suy luận toàn bộ thư mục cha là trust scope.
- Khác project: explicit opt-in/configured scope; không default toàn máy.
- Project scope là visibility filter, không phải authorization hoặc bằng chứng tin cậy.
- Dùng `realpath`, kiểm thử symlink/case sensitivity/platform paths. Không lộ path đầy đủ ngoài scope đã cho phép.
- Child teammate không tự xuất hiện như independent top-level peer ở MVP; tránh duplicate routes và lách team ownership. Peer endpoint mặc định chỉ main session.

### 6.3 Registry và liveness

- Local per-user registry; không cần central daemon hay Herdr.
- Atomic advertisements, owner-only storage/endpoint permissions; Windows cần ACL/token equivalent đã kiểm chứng.
- Chọn heartbeat/expiry qua injected clock. Giá trị khởi đầu đề xuất 10s heartbeat, 60s stale threshold; test và tune, không xem timestamp là proof process ownership.
- Clean session end unregister ngay; crash để registration stale và garbage collect có TTL.
- Kiểm tra endpoint/runtime identity trước send; registry cũ không đủ để kết luận receiver sống.
- Directory/path validation MUST chống traversal, symlink redirection và cross-user targets.
- Không adopt peer execution/process; liveness chỉ phục vụ discovery/delivery.

## 7. Messaging contracts

### 7.1 Public surface dự kiến

Giữ `send_message` cho team để tránh nhập nhằng permission. Thêm tools peer riêng ở MVP:

- `peer_sessions`: liệt kê sessions trong scope, kèm ID/name/activity/status/capability.
- `peer_send`: gửi plain text tới peer ID; tên chỉ là convenience khi unique.
- `peer_activity`: set/clear mô tả công việc hiện tại của chính session.
- UI/config để chọn inbound policy; agent không được tự nới policy qua tool.

Tên tools là đề xuất cần chốt ở phase API review. Không thêm blocking request/reply hay waiter/pong protocol.

### 7.2 Message envelope và receipts

Envelope cần `protocolVersion`, `messageId`, authenticated sender runtime address, exact recipient runtime address, plain-text body, timestamp và expiry.

Receipt tối thiểu phân biệt:

| Receipt | Ý nghĩa |
| --- | --- |
| `queued` | Durable enqueue đã thành công; chưa xác nhận injection |
| `held` | Receiver giữ message chờ chính sách/user approval |
| `delivered` | Host injection được receiver chấp nhận; không chứng minh model hiểu/hoàn thành |
| `refused` | Policy/scope/capability không cho nhận |
| `unavailable` | Target không còn reachable hoặc runtime không khớp |
| `expired` | Hết TTL trước khi được deliver |

Initial send có thể chỉ trả queued; delivered receipt có thể đến sau. Không gọi enqueue receipt là delivery confirmation.

### 7.3 Delivery behavior

- Idle receiver: serialize vào một lượt mới qua Pi SDK public API.
- Busy receiver: inject ở safe boundary qua steering mechanism; không abort tool call, không overlap turn.
- `hold`: chỉ hiện notice, không deliver body cho model trước approval.
- `refuse`: không inject và trả reason không lộ thông tin private.
- Injection error: giữ/requeue có giới hạn, backoff; không busy-loop.
- At-least-once transport + dedupe bằng message ID; không hứa exactly-once side effects sau crash.
- Bounded inbox, message size, TTL và per-sender rate limit. Giá trị khởi đầu đề xuất: body 16 KiB UTF-8, 100 pending/held mỗi receiver, TTL 1 giờ, burst 10 messages/10s/sender; chốt qua tests/config review.
- Reply là message mới có thể có `replyTo`; không chặn sender chờ response.
- Sender/receiver đóng thì không tự resume; old-runtime messages không đến incarnation mới.

### 7.4 Inbound policy và security

- `accept | hold | refuse` là policy local của receiver.
- MVP default: `hold` cho independent peers; user có thể bật accept theo trusted scope. Team messaging giữ policy hiện tại.
- Project config không được override user/managed `refuse` thành accept; precedence phải explicit và có tests.
- Peer message có provenance rõ ràng và được xử lý như untrusted agent-originated input.
- Không thể approve permission prompt, thay đổi permission settings hoặc giả user instruction bằng message.
- Plain-text `/commands`, mentions, paths không được tự expand/chạy như command.
- Không dùng team HMAC key làm shared secret cho toàn bộ peer network.
- Phải xác thực transport identity, không tin sender ID do body tự khai.
- Cùng OS user không phải sandbox chống malicious local process; tài liệu hóa threat-model giới hạn thay vì hứa isolation tuyệt đối.

### 7.5 Transport decision gate

Trước khi code, spike hai lựa chọn: reuse atomic mailbox primitives và SDK host delivery hiện có, hoặc per-session local IPC ingress + durable mailbox. Chọn một MVP, ghi ADR ngắn; không triển khai cả hai backend chỉ để linh hoạt.

Điều kiện chọn: không daemon/Herdr, address incarnation rõ, durable receipt đúng nghĩa, cross-platform evidence, không bypass permissions. Reuse existing authenticated Unix socket/Windows named-pipe helpers nếu phù hợp, nhưng không expose child control RPC cho peers.

## 8. Khi nào agent nên giao tiếp

Runtime cung cấp metadata; agent quyết định relevance. Không cần LLM nền hoặc liên tục list peers.

Các mốc check discovery:

1. Bắt đầu hoặc đổi mục tiêu lớn.
2. Gặp blocker có thể do session khác đang xử lý.
3. Chuẩn bị đổi contract/API/schema hoặc shared code có người khác đang làm.
4. Hoàn thành kết quả có ích cho peer liên quan.
5. User chỉ định session cần liên hệ.

Guidance MUST nói rõ:

- Không nhắn chỉ vì peer online; không broadcast progress vô ích.
- Ưu tiên tự đọc thông tin local nếu không cần hỏi người khác.
- Message ngắn: context, thay đổi/finding, tác động, câu hỏi cụ thể nếu có.
- Không ping lặp khi chưa có thông tin mới; không sinh auto-reply vô hạn.
- Activity cập nhật khi đổi scope, không sau từng tool call.
- Agent chỉ được chia sẻ thông tin cần thiết; không gửi secrets hoặc full conversation.
- Recipient vẫn áp dụng user intent và local permissions; message không tạo shared task ownership.

## 9. Persistence, migration và compatibility

### 9.1 Schema migration

- Inventory roster/run/mailbox/task formats trước khi thay schema; version đúng nơi có persisted contract.
- Backfill membership IDs cho live legacy members bằng một migration persisted một lần; không regenerate mỗi load.
- Legacy retired members: archive historical identity và remove live membership sau khi xác nhận không còn resource/recovery unresolved; không tự biến thành fresh active member.
- Legacy mailbox không có incarnation: archive khi migration, không đoán receiver mới theo tên.
- Legacy run/task chỉ có tên: giữ nguyên historical display, không tự gán cho member mới. Có thể bind current active records chỉ khi ownership evidence đủ rõ và được test.
- Unknown/newer schema: fail closed, không rewrite destructive.
- Preserve backup/migration markers để retry an toàn khi disk full/crash giữa migration.

### 9.2 API migration

- Canonical tool mới: `teammate_shutdown`; bỏ `teammate_retire` khỏi advertised tools.
- Không alias retire sang shutdown một cách âm thầm: semantics mới có thể stop busy work và tái sử dụng tên, mạnh hơn API cũ.
- Compatibility surface cũ nếu còn bắt buộc: trả actionable deprecation error, không tự thực hiện destructive action.
- Commands đổi sang `teammate-shutdown`; update completion/help/UI tool catalogs.
- Update integration protocol/versioned consumers nếu lifecycle/event payload thay đổi; không phát shutdown như retired để giả compatibility.
- Release notes đánh dấu behavior change kể cả package đang 0.x.

## 10. Kế hoạch triển khai theo phase

### Phase 0 — Contract inventory và ADR

- [ ] Đọc đầy đủ các services/contracts trong baseline table; map callers và locking order.
- [ ] Xác minh Pi SDK version range hiện tại hỗ trợ idle injection/steer và cancellation theo yêu cầu.
- [ ] Viết ADR cho identity/incarnation, shutdown semantics, peer trust/discovery/transport.
- [ ] Chốt tool names, settings precedence, task `in_review` release và historical named resume behavior.
- [ ] Ghi baseline tests và known native/UI verification gaps.

**Exit:** không còn quyết định mơ hồ về authority, retry, task cleanup hoặc receipt semantics.

### Phase 1 — Membership identity và stale-event isolation

- [ ] Thêm immutable membership ID vào roster/runtime và new run/reservation/message references.
- [ ] Thread identity qua child bootstrap/routing/finalization/resume thay vì name-only lookup.
- [ ] Thêm schema migration và fixtures legacy.
- [ ] Chặn old-generation callback cập nhật member mới cùng tên.

**Tests:** M1 shutdown giả lập rồi M2 cùng tên; delayed complete/mail/resume/reservation của M1 không chạm M2.

**Exit:** identity isolation đúng trước khi cho phép remove/reuse tên.

### Phase 2 — Shutdown orchestration và task cleanup

- [ ] Thêm operation intent/token và durable recovery phases.
- [ ] Implement `shutdownTeammate`; reuse stop/disposal/process guard hiện có.
- [ ] Admission checks chặn Agent, mailbox-triggered assignments, task execution và automation.
- [ ] Settle attempts, release claims và archive mailbox theo identity.
- [ ] Không delete worktree/transcript; preserve results trong completion race.
- [ ] Implement concurrent/retry behavior và structured errors.

**Exit:** queued/running/idle/released đều shutdown được; cleanup chưa verified thì membership chưa bị xóa.

### Phase 3 — Public lifecycle surface và removal của retire

- [ ] Tool/command/UI mới cho shutdown; confirmation ghi rõ cancel work + remove membership.
- [ ] Status hiển thị shutting-down/recovery phase.
- [ ] Remove advertised retire semantics và migrate legacy data an toàn.
- [ ] Update task and agent views, autocomplete, history rendering và cold-resume guidance.
- [ ] Update README, docs, skills và changelog cho lifecycle.

**Exit:** không còn docs/tool examples dạy model gọi retire; historical records vẫn đọc được.

### Phase 4 — Peer discovery infrastructure

- [ ] Implement project identity resolver cho repo/worktree/non-Git.
- [ ] Implement registry, liveness, runtime addressing, safe cleanup.
- [ ] Register main session ở start; update activity/status; unregister ở end/switch.
- [ ] Thêm explicit enable/scope settings; không advertise team children ở MVP.
- [ ] Mock clock/storage/endpoint để tests deterministic.

**Exit:** hai Pi session độc lập cùng repo discover được nhau không cần Herdr; khác project mặc định không thấy nhau.

### Phase 5 — Peer messaging, policy và host delivery

- [ ] Implement envelope/schema validation/authentication/bounds/dedupe.
- [ ] Durable enqueue, truthful receipts, retry/expiry và no-revive rule.
- [ ] Implement inbound accept/hold/refuse, held-message UI và approval flow.
- [ ] SDK safe delivery cho busy/idle; không overlap turns hoặc interrupt tool.
- [ ] Register `peer_sessions`, `peer_send`, `peer_activity`.
- [ ] Thêm agent guidance về relevance, security và tránh ping-pong.

**Exit:** bidirectional chat đúng policy, không cho peer gọi lifecycle RPC hoặc đọc transcript.

### Phase 6 — Integration, documentation và release

- [ ] End-to-end kết hợp teammate shutdown, name reuse và peer messaging.
- [ ] Native process tests trên các platform hỗ trợ; actual TUI smoke cho hold/approval/shutdown progress.
- [ ] Update configuration reference, architecture/glossary/integration docs và skill.
- [ ] Check package distribution đủ host/child code cần thiết; không edit generated dist bằng tay.
- [ ] Chạy full checks, ghi rõ automated/native/manual evidence và platform chưa verify.

**Exit:** đạt toàn bộ acceptance criteria ở mục 13.

## 11. Test matrix bắt buộc

### 11.1 Lifecycle và race conditions

| Case | Expected |
| --- | --- |
| Shutdown queued | Không launch child; reservation/claim được reconcile |
| Shutdown running tool | Request abort; bounded escalation nếu cần; không báo đóng trước proof |
| Shutdown idle/released | Cleanup đúng resources còn giữ; remove membership |
| Completion thắng shutdown | Giữ completed result; vẫn remove membership sau cleanup |
| Concurrent assignment/send/shutdown | Shutdown fence ngăn work mới sau intent |
| Hai shutdown đồng thời | Một cleanup operation, kết quả nhất quán |
| Cleanup thất bại hoặc disk full | Recovery record còn; tên chưa được reuse |
| Late finalize/mailbox event sau reuse tên | Không thay state/send vào membership mới |
| Running task attempt | Không release claim trước confirmed settlement |
| In-review/completed tasks | Outcome/history không mất; completed không quay pending |
| Auto-cascade có plan cũ | Không respawn member đã shutdown |
| Worktree có changes | Không xóa changes/checkout |
| Parent session teardown cạnh tranh | Không double-kill hoặc deadlock; không adopt foreign process |

### 11.2 Peer discovery và delivery

- Same repo, different worktrees; non-Git project; canonical path/symlink; ambiguous names.
- Stale registry, PID reuse, receiver crash, session switch, duplicate native session open.
- Không discover child teammate như peer độc lập; cross-project opt-in hoạt động.
- Idle delivery start một turn; burst messages không tạo concurrent turns.
- Busy delivery qua safe point; long-running tool không bị ngắt bởi message.
- Accept/hold/refuse; policy thay đổi khi đang held; expired/overflow receipt đúng.
- Crash sau enqueue/injection/ack; dedupe không biến thành promise exactly-once.
- Sender giả mạo, malformed envelope, oversized Unicode payload, path traversal/symlink, wrong user/token/runtime.
- Cross-scope/project settings không nới user refusal; peer text không chạy slash command hoặc authorize action.
- Dead receiver không được auto-resume; old-runtime mail không deliver vào resumed session.
- Repeated replies không có automatic infinite echo behavior.

### 11.3 Existing suites cần mở rộng

- `test/unit/team-service.test.ts`, `test/unit/domain-contracts.test.ts`.
- `test/unit/task-board-service.test.ts`, `test/unit/task-automation-service.test.ts`.
- `test/unit/teammate-routing.test.ts`, `test/unit/tool-catalog.test.ts`.
- `test/unit/ui-snapshot.test.ts`, `test/unit/agent-mention-autocomplete.test.ts`.
- `test/integration/agent-tools.test.ts`, `test/integration/session-scope.test.ts`.
- `test/integration/process-runtime.test.ts`, `test/integration/task-board-lock.test.ts`.
- `test/integration/windows-native.test.ts`, `test/render/`.
- Thêm focused suites cho shutdown races, peer discovery/policy/delivery; reuse fake backend/clock thay vì live model cho unit tests.

### 11.4 Verification commands

```bash
npm run typecheck
npm run lint
npm run depcruise
npm test
npm run package:smoke
# Hoặc toàn bộ:
npm run check
```

Native smoke phải có hai independent Pi sessions, không chỉ fake SDK host. Live provider calls chỉ chạy khi môi trường/quota được phép; ghi rõ nếu chưa chạy. TUI approval và actual terminal behavior không được kết luận chỉ từ unit tests.

## 12. Rollout, observability và recovery

- Lifecycle và peer messaging có thể release riêng; peer messaging ban đầu opt-in, same-project, inbound hold.
- Structured diagnostic events: operation/message ID, phase, timing và sanitized reason; không log body/activity/secrets mặc định.
- Shutdown progress cần cho biết waiting settlement, terminating, verifying, reconciling tasks hoặc recovery required.
- Peer status hiển thị không đủ capability/refused/unavailable mà không leak private data.
- Giới hạn retention của registrations, receipts, dedupe records và archived mailbox; không garbage collect unresolved ownership receipts.
- Rollback không được restore retired API bằng cách map sang destructive shutdown; schema mới phải được nhận biết để binary cũ không rewrite sai.
- Nếu migration không rollback được, ghi rõ minimum compatible version và quy trình backup/restore trước release.

## 13. Definition of done / acceptance criteria

### Lifecycle

- [ ] Không còn stable `retired` trong model mới hoặc advertised `teammate_retire`.
- [ ] Shutdown hoạt động khi queued/running/idle/released và không cần teammate đồng ý.
- [ ] Chỉ remove membership sau verified resource cleanup và required reconciliation.
- [ ] Không auto-complete task, không mất outcome/history/worktree changes.
- [ ] Reuse tên tạo membership mới; stale events/mail/resume không ảnh hưởng member mới.
- [ ] Retry và concurrent operations không double-dispose/deadlock/resurrect.
- [ ] Release vẫn giữ identity và không tự sửa claim; stop vẫn chỉ kết thúc assignment.

### Peer messaging

- [ ] Independent main sessions discover và nhắn được trong cùng repo/worktree scope.
- [ ] Không cần Herdr, tmux, daemon hoặc shared task board.
- [ ] Peer không có lifecycle authority; permissions và provenance được giữ.
- [ ] Busy/idle delivery serial, safe; receipt không nói quá guarantee.
- [ ] Inbound controls, resource limits, expiry/dedupe và identity validation có tests.
- [ ] Không publish transcript/thinking, không auto-resume closed session.
- [ ] Agent có activity và relevance guidance; không cần polling discovery liên tục.

### Delivery quality

- [ ] Full automated checks pass; baseline regressions được ghi rõ nếu có.
- [ ] Native process + two-session smokes có evidence theo platform.
- [ ] UI behavior được manual verification hoặc ghi rõ pending, không tuyên bố đã verify.
- [ ] Migration/compatibility/recovery instructions và release notes hoàn chỉnh.

## 14. Risks cần theo dõi

| Risk | Mitigation |
| --- | --- |
| Xóa theo tên rồi callback cũ sửa teammate mới | Membership ID end-to-end + operation tokens |
| Await stop/finalize dưới lock gây deadlock | Lock-order contract và race tests trước public API |
| Shutdown claim nhưng child vẫn chạy | Verified settlement trước board transition |
| Auto-cascade respawn tên cũ | Bind/invalidate execution plan theo membership |
| Peer messaging mở đường bypass permissions | Separate authority + inbound hold + provenance |
| Busy injection làm ngắt tool/overlap turn | SDK adapter spike và native behavioral tests |
| Shared-folder scope quá rộng | Canonical same-repo default + explicit opt-in |
| Port code pi-peer kéo theo Herdr assumptions | Reuse ideas/primitives có kiểm tra, không copy dependency model |
| Windows auth/cleanup khác Unix | Token/ACL equivalent và native CI smoke |
| Plan quá lớn thành rewrite | Ship theo phases; lifecycle trước, peer capability sau |

## 15. Tài liệu tham khảo và giới hạn bằng chứng

- Current repository: `README.md`, `docs/ARCHITECTURE.md`, `docs/CONFIGURATION.md`, `docs/INTEGRATION.md`, `docs/decisions/`, source/test paths phía trên.
- Local reference: `references/pi-peer/README.md`, `references/pi-peer/docs/ARCHITECTURE.md`. README mô tả peer registry/heartbeat, atomic mailboxes, async send và idle/busy delivery; implementation cần được đọc/audit trước khi reuse.
- Claude Agent Teams: https://code.claude.com/docs/en/agent-teams
- Claude cross-session messaging: https://code.claude.com/docs/en/cross-session-messaging

Claude docs mô tả public behavior, không phải bằng chứng về enum hoặc kiến trúc nội bộ. Shutdown của kế hoạch này cố ý khác Claude: lead quyết định stop/remove, không phải cooperative request có quyền từ chối.

File này là plan và acceptance contract cho implementation sau; không khẳng định các capability mới hoặc các native/UI checks đã được triển khai/chạy.

## 16. T3 integration verification record (2025-10-18)

This section records integration evidence; it does not convert unverified native/UI behavior into a release claim.

- [x] Pi composition registers peer discovery/send/activity tools when `peers.enabled`; session lifecycle starts/stops peer host and delivery, and receiver policy/held-message approval controls are exposed.
- [x] Membership shutdown and task reconciliation are wired through AgentManager/TaskExecutionService; API and migration guidance now describe shutdown rather than retire.
- [x] Unix authenticated transport has multi-process coverage in `test/integration/peer-transport.test.ts`; peer-runtime integration coverage is in `test/integration/peer-runtime.test.ts`.
- [x] `npm run check` passed: typecheck, Biome lint, dependency-cruiser (115 modules/443 dependencies), build, Vitest (69 passed, 1 skipped; 764 passed, 3 skipped), and package smoke.
- [ ] Native two-independent-Pi-session SDK delivery and actual TUI hold/approval/shutdown progress were not run; no provider calls were made.
- [ ] Native process shutdown/force-kill smoke and Windows peer ACL verification are outstanding. Peer transport on Windows deliberately fails closed without a genuine host ACL verifier; no Windows peer support claim is made.
- [ ] Full independent lifecycle/peer security audit and release acceptance remain outstanding.

The linked-worktree discovery test's 5-second timeout occurred under the parallel full-suite load. The underlying Git worktree setup succeeds; the focused test passes with a 15-second timeout and retains the identity equality assertion. This timeout adjustment accommodates subprocess scheduling; it does not alter the behavior assertion.

## 17. T8 native verification record (2025-10-18)

- [x] Existing `test/integration/process-runtime.test.ts` uses actual spawned native Pi SDK child processes and a local deterministic HTTP model fixture (no commercial provider). It verifies native PID/session JSONL/resume, retained named-child context and same-PID reuse, fresh context/release/termination, disconnect self-stop, and SIGKILL of an observed child followed by cleanup. `test/integration/peer-runtime.test.ts` exercises registered peer host behavior, but its runtimes are fixtures, not two independent real Pi sessions.
- [x] New `test/integration/native-shutdown-smoke.test.ts` starts a real detached OS process through the repository headless launcher, force-kills its verified owned process group, and proves PID disappearance. Focused run passed (1 test, 691 ms); focused Biome check passed. This proves launcher/process behavior, not Pi SDK shutdown or teammate membership/name reuse.
- [x] New `test/integration/native-shutdown-manager-smoke.test.ts` uses the real AgentManager, Pi SDK child process and local held HTTP model fixture. With max concurrency one, it proves a named assignment is actually queued behind a live child, shuts down the queued identity without launching another process or stopping the active holder, then shuts down a busy named child, verifies PID exit/roster removal, and creates/completes a new same-name identity. After correcting fixture model registration (`local/model` vs `local-test/local-model`), this expanded test passed three consecutive isolated runs (each ~3.1s). Local deterministic HTTP only; no commercial credentials/quota.
- [x] Follow-up focused native SDK test `npx vitest run test/integration/process-runtime.test.ts -t 'keeps, resets, releases, and retires native teammate contexts' --reporter=verbose` passed on macOS (1 passed, 18 skipped; 4.62s). It uses a real native child Pi SDK process and local deterministic HTTP model fixture; coverage includes PID/session retention, continuation, fresh context, release and name reuse under the repository's legacy retire API.
- [ ] Initial combined command `npm test -- --run test/integration/process-runtime.test.ts test/integration/peer-runtime.test.ts` built successfully but exceeded its 120-second tool timeout without reporting results. The narrowed test above establishes that test-runner startup was not generally blocked; the full focused files remain not run to completion here.
- [ ] Actual two-host SDK peer delivery/acceptance is not covered by the shutdown smoke; it is delegated to T12. Latest `npm run typecheck` passes.
- [ ] Actual two-independent-Pi-session SDK peer delivery (idle/busy/hold), async injection failure/no-loss acceptance semantics, interactive TUI observation, and Windows verification were not performed. Existing peer-runtime fixture coverage and transport tests must not be represented as actual Pi-session verification. T11 changed the adapter to await correlated SDK `message_start` acceptance; independent host delivery verification remains T12 scope. No commercial-provider call was made. Windows is unavailable on this macOS host; Windows peer ACL verification remains blocked on a genuine host ACL verifier and fails closed.
- [ ] Lifecycle audit findings reported to coordinator: cooperative stop rejection/hang can bypass enforcement when shutdown awaits stop before deadline; restart `tasks_reconciled` may remove membership after failed disposal loses its registry receipt. T9/T14 repair owns production changes; see final post-audit record below.

## 18. T13 post-audit final verification record (2025-10-18)

- [x] Final-source `npm run check` passed twice consecutively after making the delivery-group test wait on its notification condition rather than a fixed 50 ms sleep: each run passed typecheck, Biome (181 files), dependency-cruiser (116 modules/450 dependencies), build, Vitest (73 files passed, 1 platform-conditional skipped; 799 passed, 3 skipped), and package smoke. The suite ran with `maxWorkers: 4` to limit native-process contention; the concurrent aggregate inbox quota test retains its exact 100 accepted / 30 rejected assertions and uses a 15-second timeout for filesystem-lock stress.
- [x] New native coverage included: verified process-group force-kill; AgentManager queued/busy shutdown, PID exit, membership removal and same-name reuse using real Pi SDK child/local deterministic HTTP provider; two independent isolated Pi SDK sessions with signed peer runtime, held privacy, explicit approval, correlated SDK acceptance and delivered receipt using an offline local provider. No commercial provider calls.
- [x] Final independent review (report `.pi/teams/sessions/c2861e82-4469-4bd8-b9ea-31eedf8429a7/result.md`) found all five reported MAJOR issues resolved; reviewer verdict is mergeable for those repairs only, not whole-branch signoff. Repairs: stale M1 release cannot dispose M2 runtime; unresolved disposal receipts survive registry sync/restart; legacy claims migrate only when attempt ownership verifies, otherwise shutdown fails closed; corrupt/unsupported rosters are preserved rather than overwritten; held peer mail is scoped to exact recipient runtime. See T14/T15 regressions in lifecycle and peer focused suites.
- [ ] Not verified: actual Windows peer runtime (disabled/fails closed because no genuine host ACL verifier exists); production extension-loader wiring and interactive/manual TUI approval; busy SDK steering/safe-point behavior. The automated native SDK smoke is not evidence for these behaviors.
- [ ] Plan implementation is not synonymous with platform verification or whole-plan completion. Windows ACL verifier is an implementation gap; TUI/loader/busy-steer are unverified integration gaps. Ambiguous SDK acceptance timeout preserves pending mail but retry may duplicate delivery; no exactly-once claim.
- [x] No commits made. Coordinator/reviewer acceptance remains separate from this verification record.
