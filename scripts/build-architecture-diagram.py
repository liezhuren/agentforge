"""生成系统架构图（PNG）。用 Pillow 画，避免依赖 mermaid CLI。

风格与 PPT 一致：深色底、分层色块、中文标签。
输出：docs/competition/evidence/architecture.png
"""

from PIL import Image, ImageDraw, ImageFont

W, H = 1800, 1180
BG = (15, 20, 25)
PANEL = (24, 32, 40)
LINE = (43, 54, 66)
FG = (234, 240, 246)
MUTED = (154, 167, 180)
ACCENT = (53, 196, 143)
WARN = (242, 181, 68)
BAD = (232, 106, 92)
BLUE = (86, 156, 214)

FONT = "C:/Windows/Fonts/msyh.ttc"
font_title = ImageFont.truetype(FONT, 40)
font_h = ImageFont.truetype(FONT, 25)
font_l = ImageFont.truetype(FONT, 21)
font_s = ImageFont.truetype(FONT, 17)
font_xs = ImageFont.truetype(FONT, 15)

img = Image.new("RGB", (W, H), BG)
d = ImageDraw.Draw(img)


def box(x, y, w, h, fill=PANEL, outline=LINE, r=10, width=2):
    d.rounded_rectangle([x, y, x + w, y + h], radius=r, fill=fill, outline=outline, width=width)


def txt(x, y, s, f=font_l, c=FG):
    d.text((x, y), s, font=f, fill=c)


def arrow(x1, y1, x2, y2, c=LINE, width=3):
    d.line([x1, y1, x2, y2], fill=c, width=width)
    # 箭头尖
    import math

    ang = math.atan2(y2 - y1, x2 - x1)
    L = 13
    for s in (+0.42, -0.42):
        d.line(
            [x2, y2, x2 - L * math.cos(ang + s), y2 - L * math.sin(ang + s)],
            fill=c,
            width=width,
        )


# ── 标题 ────────────────────────────────────────────────────────
txt(60, 44, "AgentForge 架构", font_title, FG)
txt(60, 100, "编排内核零 LLM · 判断全部可复现 · 失败机械归因", font_h, ACCENT)

# ── 入口层 ──────────────────────────────────────────────────────
box(60, 156, 1680, 92)
txt(84, 172, "入口层", font_h, MUTED)
box(230, 172, 470, 60)
txt(250, 186, "CLI  cli-run.ts", font_l, FG)
txt(250, 208, "一次 run 一个进程", font_xs, MUTED)
box(725, 172, 470, 60)
txt(745, 186, "控制台  server/ + apps/web", font_l, FG)
txt(745, 208, "HTTP + SSE，只读投影", font_xs, MUTED)
box(1220, 172, 470, 60)
txt(1240, 186, "生成产物（被测系统）", font_l, FG)
txt(1240, 208, "A6 真启动 + HTTP 探针", font_xs, MUTED)

arrow(465, 248, 465, 292)
arrow(960, 248, 960, 292)
arrow(1455, 248, 1455, 292)

# ── 编排层（零 LLM） ────────────────────────────────────────────
box(60, 292, 1680, 196, fill=(20, 30, 28), outline=ACCENT)
txt(84, 308, "编排层  orchestrator/   —— 零 LLM 调用（判断不可能被模型带偏）", font_h, ACCENT)

items = [
    ("状态机", "8 阶段 · 唯一 Gate"),
    ("账本 R1–R10", "阻断权有界 · precision"),
    ("机械裁判", "异议裁决 / 归因"),
    ("工单", "按 targetRole 派发"),
    ("圆桌 T1–T5", "唯一允许 LLM 协商"),
    ("逃生 decideEscape", "总有出口，不会死锁"),
]
for i, (a, b) in enumerate(items):
    x = 84 + i * 275
    box(x, 356, 258, 106)
    txt(x + 16, 372, a, font_l, FG)
    txt(x + 16, 404, b, font_xs, MUTED)
    txt(x + 16, 428, "", font_xs, MUTED)

arrow(900, 488, 900, 532)

# ── 验收层（零 LLM） ────────────────────────────────────────────
box(60, 532, 820, 210, fill=(28, 24, 18), outline=WARN)
txt(84, 548, "验收层 · A 层事实锚（零 LLM）", font_h, WARN)
a_items = [
    ("A1 依赖", "声明 / 允许清单"),
    ("A2 符号", "导出真实存在"),
    ("A3 导入", "可解析"),
    ("A4 编译", "tsc 真跑"),
    ("A5 测试", "真跑 + 解析计数"),
    ("A6 探针", "真起服务探 HTTP"),
    ("A7 契约", "端点/漂移/可达性"),
    ("A8 基准", "未被产出篡改"),
]
for i, (a, b) in enumerate(a_items):
    x = 84 + (i % 4) * 196
    y = 592 + (i // 4) * 68
    box(x, y, 184, 58, fill=PANEL)
    txt(x + 10, y + 8, a, font_s, FG)
    txt(x + 10, y + 32, b, font_xs, MUTED)

box(900, 532, 840, 210, fill=(28, 20, 22), outline=BAD)
txt(924, 548, "验收层 · B 层语义锚（LLM 提议 + 机械核验）", font_h, BAD)
b_items = [
    ("B1 需求达成", "证据须真实文件+行号"),
    ("B2 需求覆盖", "PRD/任务/测试三向"),
    ("B3 异议核验", "主理人也在锚点之下"),
]
for i, (a, b) in enumerate(b_items):
    y = 600 + i * 46
    box(924, y, 792, 38, fill=PANEL)
    txt(938, y + 8, f"{a}   —— {b}", font_s, FG)
txt(924, 748, "证据编造 → 整条判定作废（INVALID_EVIDENCE）；SKIPPED ≠ PASS", font_xs, MUTED)

arrow(470, 742, 470, 786)
arrow(1320, 742, 1320, 786)

# ── 角色层 ──────────────────────────────────────────────────────
box(60, 786, 1680, 150)
txt(84, 802, "角色层  roles/   —— 上下文在代码里装配（读权限矩阵），不靠提示词自律", font_h, MUTED)
roles = [
    ("pm", "需求 / PRD / 任务图 / 冻结契约"),
    ("backend", "CodeModule(api)"),
    ("frontend", "CodeModule(web)"),
    ("test", "TestSuite / 语义验证"),
    ("host", "异议（有界阻断权）"),
]
for i, (a, b) in enumerate(roles):
    x = 84 + i * 330
    box(x, 846, 314, 70)
    txt(x + 14, 858, a, font_l, ACCENT)
    txt(x + 14, 888, b, font_xs, MUTED)

arrow(900, 936, 900, 976)

# ── 能力层 ──────────────────────────────────────────────────────
box(60, 976, 1680, 150)
txt(84, 992, "能力层", font_h, MUTED)
caps = [
    ("llm/", "Provider 抽象 · strict→json-mode→prompt-only 降级\n录制 / 回放 · 预算"),
    ("core/", "类型与 schema · 工件库(文件系统)\n哈希链决策日志 · 契约摘要"),
    ("memory/", "L1 node:sqlite+元数据\nL2 向量检索 · L3 经验库（不进判断路径）"),
]
for i, (a, b) in enumerate(caps):
    x = 84 + i * 552
    box(x, 1030, 536, 80)
    txt(x + 14, 1040, a, font_l, BLUE)
    for j, line in enumerate(b.split("\n")):
        txt(x + 14, 1070 + j * 20, line, font_xs, MUTED)

# ── 右侧竖排：横切关注点 ────────────────────────────────────────
txt(60, 1140, "横切：零运行时依赖（Node ≥24 原生剥离 TS）· 每个结论绑定内容哈希 · 决策日志哈希链 · 46 个锚点靶场样本", font_xs, MUTED)

img.save("E:/github/agentforge/docs/competition/evidence/architecture.png")
print("saved architecture.png", img.size)
