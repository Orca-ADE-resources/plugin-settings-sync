# Settings Sync: cài cho máy công ty và máy nhà

Plugin giữ Orca ở mọi máy giống nhau như VS Code Settings Sync: settings, phím tắt, plugin (kèm duyệt
quyền, bật/tắt), tuỳ chọn giao diện, file cấu hình plugin (`dim-unfocused-panes.json`). Dữ liệu nằm
trong một git repo private của bạn. Chi tiết kỹ thuật: [README.md](README.md).

## Máy công ty (máy đang có settings chuẩn)

1. Tạo repo **private, trống** (không README), ví dụ GitHub `orca-settings`.
2. Terminal: `git ls-remote https://github.com/<bạn>/orca-settings.git`. Lần đầu Git Credential
   Manager mở trình duyệt đăng nhập; không báo lỗi là được.
3. Orca → **Settings → Plugins** → ô **Development plugin folder path** → dán
   `G:\code-plugin-orca-settings-sync` → **Add path** → **Approve**.
4. Command palette → **Settings Sync: Open** (hoặc nút **Sync: set up** dưới thanh trạng thái) → dán
   URL repo → **Save**. Toast "Settings Sync: sent …" là xong lần sync đầu.

## Máy nhà

1. Cài Orca → **Settings → Plugins** → bật **Plugin system**. Cài git, chạy `git ls-remote <url repo>`
   để đăng nhập.
2. Lấy plugin từ chính repo sync (PowerShell):

   ```powershell
   git clone https://github.com/<bạn>/orca-settings.git "$env:TEMP\orca-settings"
   $dest = "$env:APPDATA\orca\settings-sync\dev-plugins\khoa.settings-sync"
   New-Item -ItemType Directory -Force $dest | Out-Null
   Copy-Item "$env:TEMP\orca-settings\dev-plugins\khoa.settings-sync\*" $dest -Recurse -Force
   $dest
   ```

3. Dán đường dẫn vừa in ra vào **Development plugin folder path** → **Add path** → **Approve**.
4. Command palette → **Settings Sync: Open** → dán URL repo → **Save** → panel hỏi → bấm
   **Use the repo's settings on this machine**.

Xong: settings, phím tắt, giao diện giống máy công ty; plugin Dim Unfocused Panes được copy về, tự duyệt,
tự bật, cùng độ dim. Plugin Settings Sync ở máy nhà nằm trong thư mục do sync quản lý, nên sửa plugin ở
máy công ty thì máy nhà tự cập nhật.

## Dùng hằng ngày

- Thanh trạng thái dưới đáy có nút **Last sync 2m ago** (đang sync: Syncing…, lỗi: Sync failed); bấm
  vào để mở panel. Không có phím tắt: Orca 1.4.269 bắt duyệt lại plugin dev có phím tắt sau mỗi lần
  file của nó đổi.
- Không cần làm gì: sync khi mở Orca, khi quay lại cửa sổ Orca (tối đa 1 lần/phút), mỗi 5 phút, và
  ~5 giây sau khi bạn đổi setting/phím tắt/plugin.
- Hai máy đổi **khác** key: giữ cả hai. Đổi **cùng** key: thay đổi mới hơn thắng, panel ghi lại.
- **History** trong panel: mỗi lần sync là một commit; **Preview** xem sẽ đổi gì, **Restore** đưa máy
  này về lúc đó rồi đẩy sang các máy khác.
- Không sync: tài khoản/token, biến môi trường agent, proxy, đường dẫn riêng của máy (workspace, shell,
  SDK, file âm thanh, model voice), WSL, ghép nối điện thoại, kích thước cửa sổ/sidebar.
- Duyệt plugin: repo ghi plugin được duyệt xin quyền gì (với plugin cài từ git/marketplace có chạy code:
  thêm commit). Máy kia tự duyệt bản của nó khi bản đó xin đúng như vậy. Plugin chưa cài ở máy này thì
  chờ, không báo; cài xong là tự duyệt. Bản copy dev do sync cập nhật (`settings-sync\dev-plugins\…`)
  bị Orca hỏi lại vì file đổi thì sync tự duyệt lại nếu quyền không đổi. Thư mục dev của chính bạn thì
  sync không duyệt hộ: sửa plugin có phím tắt (như dim) xong, Orca hỏi, bấm **Approve**.
- Bỏ một nhóm: bỏ tick trong **What to sync**. Bỏ một setting cụ thể: thêm tên key vào
  `excludeSettings` trong `%APPDATA%\orca\settings-sync\config.json`.

## Khi có lỗi

| Panel báo | Làm |
|---|---|
| Git could not sign in | Chạy `git ls-remote <url>` trong terminal để đăng nhập, rồi **Sync now** |
| Sync repo not found | Sai URL, hoặc tài khoản git máy này không có quyền đọc repo |
| Offline | Không làm gì; thay đổi được giữ và đẩy lên khi có mạng |
| Not applied here: …different permissions | Bản plugin ở máy này xin quyền khác bản đã duyệt ở máy kia: xem rồi duyệt tay trong Settings → Plugins |
| Not applied here: …different release | Máy này cài ra commit khác máy kia (nhánh đã có commit mới): xem rồi duyệt tay |
| Không thấy gì sau khi mở lại Orca | Engine chạy khi có sự kiện đầu tiên (agent đổi trạng thái) hoặc chạy **Settings Sync: Open** trong command palette |

Log: nút **Log** trong panel (`%APPDATA%\orca\settings-sync\sync.log`).
