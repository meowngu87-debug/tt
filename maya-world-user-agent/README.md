# Maya World/User Agent Runtime

Runtime firewall cho preset Minh_Nguyet_Thu_Thanh_Maya_HYBRID_D100_WORLD_USER_v2.

## Luồng

USER INPUT -> USER AGENT -> USER_RESULT -> WORLD AGENT -> hidden WORLD STATE / Background Ledger -> visible reveal boundary -> MAIN ST GENERATION.

USER agent chỉ nhận persona và input thật của user.
WORLD agent nhận chat/world context và hidden world state.
Main narrator chỉ nhận USER_RESULT và phần visible của WORLD_RESULT.

Extension này không thay thế D100, Character Autonomy, OCC, World Rules hay prose engine của preset.

## Cài

Đặt thư mục `maya-world-user-agent` vào `data/<user>/extensions/third-party/`, hoặc cài ZIP qua Extensions nếu bản SillyTavern của bạn hỗ trợ. Reload ST rồi bật extension.

## Lưu ý

- Hidden ledger nằm trong chat metadata và không được đưa trực tiếp vào main prompt.
- D100 hiện hữu của preset vẫn là hệ thống phán quyết chính.
- Bản 0.1 dùng cùng connection/profile của SillyTavern cho hai auxiliary calls; firewall nằm ở context routing.
- Chưa có autonomous background tick khi không có lượt chat.
