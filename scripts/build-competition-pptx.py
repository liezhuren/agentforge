"""生成 AgentForge 赛道 B 的 8 页 PPT（可编辑文本 + 原生绘制的架构图）。

内容取自 docs/competition/07-PPT大纲（8页）.md，数字全部来自 docs/competition/10-实测证据.md。
"""

from pptx import Presentation
from pptx.util import Inches, Pt, Emu
from pptx.dml.color import RGBColor
from pptx.enum.text import PP_ALIGN, MSO_ANCHOR
from pptx.enum.shapes import MSO_SHAPE

# ── 配色（深色底 + 高对比）─────────────────────────────────────
BG = RGBColor(0x0F, 0x14, 0x19)
FG = RGBColor(0xEA, 0xF0, 0xF6)
MUTED = RGBColor(0x9A, 0xA7, 0xB4)
ACCENT = RGBColor(0x35, 0xC4, 0x8F)   # 绿：通过 / 正向
WARN = RGBColor(0xF2, 0xB5, 0x44)     # 黄：警告
BAD = RGBColor(0xE8, 0x6A, 0x5C)      # 红：失败
PANEL = RGBColor(0x18, 0x20, 0x28)
LINE = RGBColor(0x2B, 0x36, 0x42)

W, H = Inches(13.333), Inches(7.5)

prs = Presentation()
prs.slide_width = W
prs.slide_height = H
BLANK = prs.slide_layouts[6]


def slide():
    s = prs.slides.add_slide(BLANK)
    bg = s.shapes.add_shape(MSO_SHAPE.RECTANGLE, 0, 0, W, H)
    bg.fill.solid()
    bg.fill.fore_color.rgb = BG
    bg.line.fill.background()
    bg.shadow.inherit = False
    return s


def text(s, x, y, w, h, size, color=FG, bold=False, align=PP_ALIGN.LEFT, wrap=True):
    box = s.shapes.add_textbox(x, y, w, h)
    tf = box.text_frame
    tf.word_wrap = wrap
    tf.margin_left = 0
    tf.margin_right = 0
    tf.margin_top = 0
    tf.margin_bottom = 0
    p = tf.paragraphs[0]
    p.alignment = align
    r = p.add_run()
    r.text = ""
    r.font.size = Pt(size)
    r.font.bold = bold
    r.font.color.rgb = color
    r.font.name = "Microsoft YaHei"
    return box


def para(tf, content, size, color=FG, bold=False, space_before=0, first=False, align=PP_ALIGN.LEFT):
    p = tf.paragraphs[0] if first else tf.add_paragraph()
    p.space_before = Pt(space_before)
    p.alignment = align
    r = p.add_run()
    r.text = content
    r.font.size = Pt(size)
    r.font.bold = bold
    r.font.color.rgb = color
    r.font.name = "Microsoft YaHei"
    return p


def panel(s, x, y, w, h, fill=PANEL, line=LINE):
    sh = s.shapes.add_shape(MSO_SHAPE.ROUNDED_RECTANGLE, x, y, w, h)
    sh.fill.solid()
    sh.fill.fore_color.rgb = fill
    sh.line.color.rgb = line
    sh.line.width = Pt(1)
    sh.shadow.inherit = False
    sh.adjustments[0] = 0.06
    return sh


def header(s, kicker, title, sub=None):
    t = text(s, Inches(0.7), Inches(0.45), Inches(11.9), Inches(0.4), 13, ACCENT, True)
    para(t.text_frame, kicker, 13, ACCENT, True, first=True)
    t2 = text(s, Inches(0.7), Inches(0.85), Inches(11.9), Inches(0.8), 30, FG, True)
    para(t2.text_frame, title, 30, FG, True, first=True)
    if sub:
        t3 = text(s, Inches(0.7), Inches(1.62), Inches(11.9), Inches(0.5), 14, MUTED)
        para(t3.text_frame, sub, 14, MUTED, first=True)
    ln = s.shapes.add_connector(1, Inches(0.7), Inches(1.55), Inches(12.63), Inches(1.55))
    ln.line.color.rgb = LINE
    ln.line.width = Pt(1)


def footer(s, total=9):
    n = len(prs.slides)
    f = text(s, Inches(0.7), Inches(6.95), Inches(8), Inches(0.3), 10, MUTED)
    para(f.text_frame, "AgentForge · 多角色 AI 研发引擎 · 赛道 B", 10, MUTED, first=True)
    g = text(s, Inches(11.6), Inches(6.95), Inches(1), Inches(0.3), 10, MUTED, align=PP_ALIGN.RIGHT)
    para(g.text_frame, f"{n} / {total}", 10, MUTED, first=True)


def box(s, x, y, w, h, label, sub, color=FG, size=12, sub_size=10, fill=PANEL):
    p = panel(s, x, y, w, h, fill)
    tf = p.text_frame
    tf.word_wrap = True
    tf.margin_left = Emu(91440)
    tf.margin_right = Emu(91440)
    tf.margin_top = Emu(45720)
    tf.margin_bottom = Emu(45720)
    tf.vertical_anchor = MSO_ANCHOR.MIDDLE
    p1 = tf.paragraphs[0]
    p1.alignment = PP_ALIGN.CENTER
    r = p1.add_run()
    r.text = label
    r.font.size = Pt(size)
    r.font.bold = True
    r.font.color.rgb = color
    r.font.name = "Microsoft YaHei"
    if sub:
        p2 = tf.add_paragraph()
        p2.alignment = PP_ALIGN.CENTER
        r2 = p2.add_run()
        r2.text = sub
        r2.font.size = Pt(sub_size)
        r2.font.color.rgb = MUTED
        r2.font.name = "Microsoft YaHei"
    return p


def arrow(s, x1, y1, x2, y2, color=LINE):
    c = s.shapes.add_connector(1, x1, y1, x2, y2)
    c.line.color.rgb = color
    c.line.width = Pt(1.25)
    return c


# ══════════════════════════════════════════════════════════════
# 第 1 页 · 标题
# ══════════════════════════════════════════════════════════════
s = slide()
header(s, "项目概述", "AgentForge",
       "让 AI 面对复杂任务时不跑偏、不走样、可被验证")

# 左：解决什么问题
p = panel(s, Inches(0.7), Inches(1.95), Inches(5.85), Inches(3.05))
tf = p.text_frame
tf.word_wrap = True
tf.margin_left = Emu(182880)
tf.margin_top = Emu(137160)
para(tf, "解决什么问题", 15, BAD, True, first=True)
para(tf, "① 上下文越长，目标偏移越严重", 13, FG, True, space_before=12)
para(tf, "而复杂任务必然带来长上下文 —— 模型写着写着就忘了最初要什么", 11, MUTED, space_before=2)
para(tf, "② 单次生成质量不稳", 13, FG, True, space_before=10)
para(tf, "同一份需求两次生成，结果不一样 —— 无法复现，也无法回归", 11, MUTED, space_before=2)
para(tf, "③ 生成结果难以验证", 13, FG, True, space_before=10)
para(tf, "「看起来做完了」和「真的做完了」在代码库里长得几乎一样", 11, MUTED, space_before=2)

# 右：最终做出了什么
p = panel(s, Inches(6.78), Inches(1.95), Inches(5.85), Inches(3.05))
tf = p.text_frame
tf.word_wrap = True
tf.margin_left = Emu(182880)
tf.margin_top = Emu(137160)
para(tf, "最终做出了什么", 15, ACCENT, True, first=True)
para(tf, "一个多角色研发引擎", 13, FG, True, space_before=12)
para(tf, "8 个阶段 · 11 条确定性锚点 · LLM 只负责产出，永远不是最终裁判", 11, MUTED, space_before=2)
para(tf, "产物 A：可运行的系统", 13, FG, True, space_before=10)
para(tf, "茶歇系统 22 / 22 测试、33 / 33 端到端，零依赖即可启动", 11, MUTED, space_before=2)
para(tf, "产物 B：可复核的交付结论", 13, FG, True, space_before=10)
para(tf, "14/14 与 22/22 条需求逐条确认达成，fullyVerified = true", 11, MUTED, space_before=2)

# 底部证据条
res = panel(s, Inches(0.7), Inches(5.22), Inches(11.93), Inches(0.95), PANEL, ACCENT)
tf = res.text_frame
tf.word_wrap = True
tf.margin_left = Emu(182880)
tf.vertical_anchor = MSO_ANCHOR.MIDDLE
para(tf, "真实大模型完整交付 ×2（14/14 与 22/22 需求达成）· 每次 7 个门禁 · 两次打回都被修好 · 0 技术债",
     14, ACCENT, True, first=True)
para(tf, "凭证：docs/competition/evidence/brief-s3/（verdict / gates / decisions / 调用记录）", 11, MUTED, space_before=3)

t = text(s, Inches(0.7), Inches(6.42), Inches(7), Inches(0.35), 12, MUTED)
para(t.text_frame, "刘泽 · B23040610", 12, MUTED, first=True)

# ══════════════════════════════════════════════════════════════
# 第 2 页 · 痛点：假绿灯
# ══════════════════════════════════════════════════════════════
s = slide()
header(s, "问题与目标", "AI 生成的两个本质问题：随机，且难验证",
       "真正的瓶颈不是「能不能生成」，而是「敢不敢把它交付出去」")

col_w = Inches(5.85)
# 左：为什么值得解决
p = panel(s, Inches(0.7), Inches(1.95), col_w, Inches(3.45))
tf = p.text_frame
tf.word_wrap = True
tf.margin_left = Emu(182880)
tf.margin_top = Emu(137160)
para(tf, "为什么值得解决", 15, BAD, True, first=True)
para(tf, "随机性", 13, FG, True, space_before=12)
para(tf, "同一需求两次生成结果不同 —— 无法复现、无法回归、也无法承诺", 11, MUTED, space_before=2)
para(tf, "难验证", 13, FG, True, space_before=10)
para(tf, "模型说「完成了」，但编译、测试、真实运行都可能不成立；", 11, MUTED, space_before=2)
para(tf, "而用另一个 LLM 去验证，等于让被告当法官", 11, WARN, space_before=2)
para(tf, "实测反例（我们自己的产物）", 12, FG, True, space_before=10)
para(tf, "4,443 行代码 · tsc 通过 · 39 条测试 —— 12 个端点却一律返回 501，", 10, MUTED, space_before=2)
para(tf, "而当时的检查报「17 个端点全部已实现」", 10, MUTED, space_before=1)

# 右：成功标准
p = panel(s, Inches(6.78), Inches(1.95), col_w, Inches(3.45))
tf = p.text_frame
tf.word_wrap = True
tf.margin_left = Emu(182880)
tf.margin_top = Emu(137160)
para(tf, "成功标准（可判定，不靠主观）", 15, ACCENT, True, first=True)
para(tf, "① 机械层全过", 13, FG, True, space_before=12)
para(tf, "编译通过 · 测试真跑且全绿 · 服务真启动并响应 HTTP 探针", 11, MUTED, space_before=2)
para(tf, "② 需求层逐条判定", 13, FG, True, space_before=10)
para(tf, "每条需求的判定必须附真实文件与真实行号区间；编造证据 → 整条作废", 11, MUTED, space_before=2)
para(tf, "③ 不许自我满足", 13, FG, True, space_before=10)
para(tf, "空交付 / SKIPPED / 带债 都必须显式记账，且都不算「通过」", 11, MUTED, space_before=2)
para(tf, "三条同时满足 = fullyVerified（真·完整交付）", 12, ACCENT, True, space_before=12)

# 底部：这条标准已经被用过两次
p = panel(s, Inches(0.7), Inches(5.55), Inches(11.93), Inches(0.9))
tf = p.text_frame
tf.word_wrap = True
tf.margin_left = Emu(182880)
tf.vertical_anchor = MSO_ANCHOR.MIDDLE
para(tf, "这条标准不是口号 —— 同一套判据，刚刚用出两个相反结果：", 12, ACCENT, True, first=True)
para(tf, "① 认证了两次真交付（14/14、22/22 + fullyVerified）　② 拦下了一次空交付（只有规格、零代码，被判 fail）",
     11, MUTED, space_before=3)
footer(s)

# ══════════════════════════════════════════════════════════════
# 第 3 页 · 实跑产物：茶歇系统（这是全场最硬的一页）
# ══════════════════════════════════════════════════════════════
s = slide()
header(s, "实跑产物", "先看东西：一个 AI 写出来、真的能跑的系统",
       "demo/coffeebreak/ · 20 个 TypeScript 源文件 · 零第三方依赖（不装任何包就能启动）")

SHOT = r"E:\github\agentforge\docs\competition\evidence\cb-6-ui-home.png"
shot_w = Inches(7.05)
shot_h = int(shot_w * 900 / 1440)
s.shapes.add_picture(SHOT, Inches(0.7), Inches(1.98), width=shot_w, height=shot_h)
cap = text(s, Inches(0.7), Inches(1.98) + shot_h + Inches(0.08), Inches(7.05), Inches(0.3), 10, MUTED)
para(cap.text_frame, "真实界面截图（headless 浏览器，1440×900）· 20 个 TypeScript 源文件 · 22/22 测试 · 33/33 端到端", 10, MUTED, first=True)

# 右侧：数字与旅程
x = Inches(8.05)
w = Inches(4.58)

p = panel(s, x, Inches(1.95), w, Inches(1.42), PANEL, ACCENT)
tf = p.text_frame
tf.word_wrap = True
tf.margin_left = Emu(137160)
tf.margin_top = Emu(91440)
para(tf, "可复核的验收结果", 12, ACCENT, True, first=True)
para(tf, "22 / 22   单元 + 集成测试", 14, FG, True, space_before=8)
para(tf, "33 / 33   真实 HTTP 端到端验收", 14, FG, True, space_before=4)
para(tf, "18 / 18   任务书要求的论文属性（建→读回）", 12, FG, space_before=4)

p = panel(s, x, Inches(3.47), w, Inches(2.2))
tf = p.text_frame
tf.word_wrap = True
tf.margin_left = Emu(137160)
tf.margin_top = Emu(91440)
para(tf, "演示动线（3 分钟够走完）", 12, ACCENT, True, first=True)
para(tf, "① 注册 → 登录（Bearer 会话）", 11, FG, space_before=8)
para(tf, "② 管理员建论文，18 项属性逐项落库", 11, FG, space_before=4)
para(tf, "③ 评论 + 对评论的回复（父子结构）", 11, FG, space_before=4)
para(tf, "④ 加好友 / 关注 / 设兴趣 → 推荐重排", 11, FG, space_before=4)
para(tf, "⑤ 普通用户删论文 → 403（权限边界）", 11, FG, space_before=4)

p = panel(s, x, Inches(5.78), w, Inches(1.05))
tf = p.text_frame
tf.word_wrap = True
tf.margin_left = Emu(137160)
tf.vertical_anchor = MSO_ANCHOR.MIDDLE
para(tf, "生成成本", 11, ACCENT, True, first=True)
para(tf, "40–75 分钟 · 约 100 万 token · ≈ $1–2（吞吐 ~200 tok/s）", 10, MUTED, space_before=3)
footer(s)
# ══════════════════════════════════════════════════════════════
# 第 4 页 · 根因：输入被饿死
# ══════════════════════════════════════════════════════════════
s = slide()
header(s, "根因", "不是模型不行，是系统在让角色「盲写」",
       "30 次调用、113 万 token，而每次调用的输入恒定在 10.6k")

# 左：折线图（原生 shapes 画）
chart_x, chart_y = Inches(0.75), Inches(2.05)
chart_w, chart_h = Inches(6.1), Inches(1.95)
ax = s.shapes.add_connector(1, chart_x, chart_y + chart_h, chart_x + chart_w, chart_y + chart_h)
ax.line.color.rgb = LINE
ay = s.shapes.add_connector(1, chart_x, chart_y, chart_x, chart_y + chart_h)
ay.line.color.rgb = LINE

# 数据点：输入 token 几乎恒定（10,669 → 10,664），用很小的纵向区间表达"平"
xs = [0.05, 0.19, 0.33, 0.47, 0.61, 0.75, 0.9]
vals = [10669, 10674, 10686, 10666, 10667, 10664, 10706]
base = chart_y + chart_h
scale = Inches(0.62) / 46.0   # 把 [10660,10706] 映射到约 0.62 英寸
for i, (fx, v) in enumerate(zip(xs, vals)):
    px = chart_x + int(chart_w * fx)
    py = base - Emu(int(Inches(0.95) + (v - 10660) * scale))
    dot = s.shapes.add_shape(MSO_SHAPE.OVAL, px - Emu(43815), py - Emu(43815), Emu(87630), Emu(87630))
    dot.fill.solid()
    dot.fill.fore_color.rgb = BAD
    dot.line.fill.background()
    if i > 0:
        prev_x = chart_x + int(chart_w * xs[i - 1])
        prev_v = vals[i - 1]
        prev_y = base - Emu(int(Inches(0.95) + (prev_v - 10660) * scale))
        arrow(s, prev_x, prev_y, px, py, BAD)

lbl2 = text(s, chart_x, base + Inches(0.14), Inches(6.0), Inches(0.3), 11, MUTED)
para(lbl2.text_frame, "横轴：项目规模 0 → 4,443 行   ｜   纵轴：输入 token ≈ 10.6k（几乎不动）", 11, MUTED, first=True)

# 右侧三个数字
stats = [
    ("95%", "24,000 字符的上下文被「需求 + PRD + 任务图」吃掉", BAD),
    ("4.2%", "54 万字符的工件里，真正送达模型的只有这么多", BAD),
    ("2.2 : 1", "输出 / 输入 —— 每次都在从零重写，而不是修改", WARN),
]
y = Inches(2.05)
for big, desc, col in stats:
    p = panel(s, Inches(7.05), y, Inches(5.58), Inches(0.78))
    tb = text(s, Inches(7.25), y + Inches(0.1), Inches(1.35), Inches(0.55), 24, col, True)
    para(tb.text_frame, big, 24, col, True, first=True)
    td = text(s, Inches(8.62), y + Inches(0.17), Inches(3.85), Inches(0.55), 11, FG)
    para(td.text_frame, desc, 11, FG, first=True)
    y += Inches(0.9)

p = panel(s, Inches(0.7), Inches(4.95), Inches(11.93), Inches(1.5))
tf = p.text_frame
tf.word_wrap = True
tf.margin_left = Emu(182880)
tf.vertical_anchor = MSO_ANCHOR.MIDDLE
para(tf, "关键判据", 12, ACCENT, True, first=True)
para(tf, "契约（60,720 字符）整件丢失 → 后端照 PRD 散文自己发明接口；别人的代码一件没进 → 不可能接线；测试报告一件没进 → 连修 6 轮不收敛。",
     13, FG, space_before=4)
footer(s)

# ══════════════════════════════════════════════════════════════
# 第 4 页 · 架构
# ══════════════════════════════════════════════════════════════
s = slide()
header(s, "架构", "编排内核零 LLM，判断不可能被模型带偏")

# 分层块
layers = [
    ("入口", "CLI · Web 控制台", "cli-run.ts · server/", MUTED),
    ("编排层", "8 阶段状态机 · 唯一 Gate · 账本 · 机械裁判 · 圆桌 · 逃生", "orchestrator/（零 LLM 调用）", ACCENT),
    ("验收层", "A1–A8 事实锚（编译/测试/探针/契约/基准） · B1–B3 语义锚", "anchors/（LLM 提议 + 机械核验）", ACCENT),
    ("角色层", "pm · backend · frontend · test · host", "roles/（上下文装配 + schema 门禁）", FG),
    ("能力层", "Provider 抽象 · 录制回放 · 三层记忆 · 工件库 · 哈希链日志", "llm/ · memory/ · core/", MUTED),
]
y = Inches(1.95)
for name, desc, pkg, col in layers:
    p = panel(s, Inches(0.7), y, Inches(9.05), Inches(0.78))
    tn = text(s, Inches(0.92), y + Inches(0.19), Inches(1.25), Inches(0.4), 14, col, True)
    para(tn.text_frame, name, 14, col, True, first=True)
    td = text(s, Inches(2.2), y + Inches(0.09), Inches(5.7), Inches(0.6), 12, FG)
    para(td.text_frame, desc, 12, FG, first=True)
    tp = text(s, Inches(7.6), y + Inches(0.19), Inches(1.98), Inches(0.4), 10, MUTED, align=PP_ALIGN.RIGHT)
    para(tp.text_frame, pkg, 10, MUTED, first=True)
    y += Inches(0.88)

# 右侧三个设计决定
p = panel(s, Inches(9.95), Inches(1.95), Inches(2.68), Inches(3.9))
tf = p.text_frame
tf.word_wrap = True
tf.margin_left = Emu(137160)
tf.margin_top = Emu(109728)
para(tf, "三个设计决定", 13, ACCENT, True, first=True)
para(tf, "① 编排里没有一次 LLM 调用", 11, FG, space_before=12)
para(tf, "② SKIPPED ≠ PASS", 11, FG, space_before=8)
para(tf, "③ 8 个阶段共用同一个 Gate", 11, FG, space_before=8)

p = panel(s, Inches(0.7), Inches(6.35), Inches(11.93), Inches(0.5))
tf = p.text_frame
tf.word_wrap = True
tf.margin_left = Emu(137160)
tf.vertical_anchor = MSO_ANCHOR.MIDDLE
para(tf, "零依赖：Node ≥ 24 原生执行 TypeScript，克隆即跑（401 个测试；CI 断言仓库根目录没有 node_modules）", 11, MUTED, first=True)
footer(s)

# ══════════════════════════════════════════════════════════════
# 第 5 页 · Agent 通信
# ══════════════════════════════════════════════════════════════
s = slide()
header(s, "Agent 链路", "五个角色不直接对话，只传接口",
       "谁能看到什么由代码强制，不靠提示词自律")

# 左：错误做法
p = panel(s, Inches(0.7), Inches(1.95), Inches(5.6), Inches(3.55))
tf = p.text_frame
tf.word_wrap = True
tf.margin_left = Emu(182880)
tf.margin_top = Emu(137160)
para(tf, "✗ 全文互传", 16, BAD, True, first=True)
para(tf, "把全部源码堆进一个大上下文 =", 12, FG, space_before=12)
para(tf, "把多角色系统退化成单一大上下文，", 12, FG, space_before=4)
para(tf, "切分就白做了；", 12, FG, space_before=4)
para(tf, "而且下一个更大的项目会再次溢出。", 12, FG, space_before=4)
para(tf, "实测：11 个模块全文 = 20 万字符", 11, MUTED, space_before=14)

# 右：我们的做法
p = panel(s, Inches(6.62), Inches(1.95), Inches(6.01), Inches(3.55))
tf = p.text_frame
tf.word_wrap = True
tf.margin_left = Emu(182880)
tf.margin_top = Emu(137160)
para(tf, "✓ 接口卡：只给导出签名", 16, ACCENT, True, first=True)
para(tf, "export function handlePapersRoute(req: PapersRequest): PapersResponse | null", 11, FG,
     space_before=14)
para(tf, "export function listPapers(): PaperRecord[]", 11, FG, space_before=4)
para(tf, "export interface PaperRecord", 11, FG, space_before=4)
para(tf, "实测：11 个模块的全部签名 ≈ 5 千字符", 11, ACCENT, space_before=14)
para(tf, "与全文相差 40 倍 —— 这是「只传接口」的量化价值", 11, MUTED, space_before=4)

# 底部：六种通道 + 五层配额
p = panel(s, Inches(0.7), Inches(5.68), Inches(5.6), Inches(1.15))
tf = p.text_frame
tf.word_wrap = True
tf.margin_left = Emu(137160)
tf.vertical_anchor = MSO_ANCHOR.MIDDLE
para(tf, "六种通信通道", 12, ACCENT, True, first=True)
para(tf, "工件库 · 读权限矩阵 · 契约（唯一必须送达）· 模块接口卡 · 工单 · 圆桌", 10, FG, space_before=4)

p = panel(s, Inches(6.62), Inches(5.68), Inches(6.01), Inches(1.15))
tf = p.text_frame
tf.word_wrap = True
tf.margin_left = Emu(137160)
tf.vertical_anchor = MSO_ANCHOR.MIDDLE
para(tf, "五层配额（从「谁先谁得」改成「谁需要谁得」）", 12, ACCENT, True, first=True)
para(tf, "规格 → 执行事实 → 模块接口 → 代码全文 → 需求计划（关键三件保证送达）", 11, FG, space_before=4)
footer(s)

# ══════════════════════════════════════════════════════════════
# 第 6 页 · 异常处理
# ══════════════════════════════════════════════════════════════
s = slide()
header(s, "异常处理", "四层逃生，机械判定，保证不死锁",
       "decideEscape() 的三个分支穷举了所有情况 —— 它一定返回一个可执行动作")

steps = [
    ("① 打回返工", "能归因就先打回；一条都归不了因才开会", "便宜、确定、有明确验收条件", ACCENT),
    ("② 圆桌会议", "唯一允许 LLM 协商的地方（T1–T5）", "只「归因完全失灵」才触发", WARN),
    ("③ 升级真人", "打包成仲裁包，人只需做一次决定", "圆桌无有效决议时", WARN),
    ("④ 带债通过", "写 DebtRecord + 需求标 accepted_with_debt", "真人不可用时的最终出口", MUTED),
]
y = Inches(1.95)
for name, desc, why, col in steps:
    p = panel(s, Inches(0.7), y, Inches(7.4), Inches(0.86))
    tn = text(s, Inches(0.92), y + Inches(0.13), Inches(2.0), Inches(0.4), 15, col, True)
    para(tn.text_frame, name, 15, col, True, first=True)
    td = text(s, Inches(2.9), y + Inches(0.11), Inches(5.0), Inches(0.3), 11, FG)
    para(td.text_frame, desc, 11, FG, first=True)
    tw = text(s, Inches(2.9), y + Inches(0.42), Inches(5.0), Inches(0.3), 10, MUTED)
    para(tw.text_frame, why, 10, MUTED, first=True)
    y += Inches(0.98)

# 右侧：防空转
p = panel(s, Inches(8.35), Inches(1.95), Inches(4.28), Inches(3.72))
tf = p.text_frame
tf.word_wrap = True
tf.margin_left = Emu(164592)
tf.margin_top = Emu(128016)
para(tf, "四个防空转机制", 14, ACCENT, True, first=True)
para(tf, "阻断 3 次后权限自动终止", 11, FG, space_before=12)
para(tf, "否则两个 Agent 能互相否决到死", 10, MUTED, space_before=2)
para(tf, "签名未变 → 不再开会", 11, FG, space_before=10)
para(tf, "实测过某阶段连开 6 次圆桌", 10, MUTED, space_before=2)
para(tf, "修复无效 → 直接转逃生", 11, FG, space_before=10)
para(tf, "不重复付费", 10, MUTED, space_before=2)
para(tf, "上下文超长 → 预算减半重试", 11, FG, space_before=10)
para(tf, "不让一次 400 打死整轮 run", 10, MUTED, space_before=2)

p = panel(s, Inches(0.7), Inches(6.05), Inches(11.93), Inches(0.78))
tf = p.text_frame
tf.word_wrap = True
tf.margin_left = Emu(182880)
tf.vertical_anchor = MSO_ANCHOR.MIDDLE
para(tf, "真实日志", 10, ACCENT, True, first=True)
para(tf, "[CONTRACTING] 工单修复后硬失败签名未变（pm 的修复没有改变任何东西），不再重复重试，转逃生流程 → 带债通过（受影响需求 3 条）",
     11, MUTED, space_before=2)
footer(s)

# ══════════════════════════════════════════════════════════════
# 第 7 页 · 可观测性
# ══════════════════════════════════════════════════════════════
s = slide()
header(s, "可观测性", "能回答「它到底看到了什么」",
       "在这一行存在之前，「为什么它老是做不对」只能靠猜 —— 我们为此花了两小时复算")

# 左：日志样例
p = panel(s, Inches(0.7), Inches(1.95), Inches(7.3), Inches(2.75))
tf = p.text_frame
tf.word_wrap = True
tf.margin_left = Emu(164592)
tf.margin_top = Emu(128016)
para(tf, "run 日志里的输入审计（每次调用都记）", 12, ACCENT, True, first=True)
para(tf, "上下文：23,177 / 60,000 字符（39%）  注入 3 个 · 丢弃 0 个", 12, FG, space_before=12)
para(tf, "  其中契约摘要 1 个", 11, MUTED, space_before=2)
para(tf, "  未注入：TaskGraph-001(15520·tier-cap)", 11, MUTED, space_before=2)
para(tf, "  injected[]: {id, kind, chars, digest? | card?}", 11, MUTED, space_before=10)
para(tf, "  omitted[]: {id, kind, chars, reason: tier-cap | no-space}", 11, MUTED, space_before=2)

# 右：三个抓手
items = [
    ("哈希链日志", "任何一条被改，链就断", ACCENT),
    ("回放", "同一批模型输出可重放，把不确定性从实验里摘出去", FG),
    ("锚点靶场", "45 个样本标定检查本身准不准", WARN),
]
y = Inches(1.95)
for name, desc, col in items:
    p = panel(s, Inches(8.25), y, Inches(4.38), Inches(0.83))
    tn = text(s, Inches(8.45), y + Inches(0.12), Inches(4.0), Inches(0.3), 13, col, True)
    para(tn.text_frame, name, 13, col, True, first=True)
    td = text(s, Inches(8.45), y + Inches(0.43), Inches(4.0), Inches(0.35), 10, MUTED)
    para(td.text_frame, desc, 10, MUTED, first=True)
    y += Inches(0.95)

# 底部靶场结果
p = panel(s, Inches(0.7), Inches(4.95), Inches(11.93), Inches(1.75))
tf = p.text_frame
tf.word_wrap = True
tf.margin_left = Emu(182880)
tf.margin_top = Emu(109728)
para(tf, "靶场：45 个样本（30 注入 + 15 干净对照）", 13, ACCENT, True, first=True)
para(tf, "TP 30    FN 0    FP 0    TN 15    严重度不符 0", 18, FG, True, space_before=8)
para(tf, "「干净通过率」比「检出率」更重要：一条会对好代码报警的检查，会让角色学会糊弄它 —— 此后所有真报都会被降权。",
     11, MUTED, space_before=6)
footer(s)

# ══════════════════════════════════════════════════════════════
# 第 8 页 · 结论
# ══════════════════════════════════════════════════════════════
s = slide()
header(s, "结论", "已经做到的，和还没做到的")

p = panel(s, Inches(0.7), Inches(1.95), Inches(5.8), Inches(3.95))
tf = p.text_frame
tf.word_wrap = True
tf.margin_left = Emu(182880)
tf.margin_top = Emu(137160)
tf.vertical_anchor = MSO_ANCHOR.TOP
para(tf, "已经做到", 16, ACCENT, True, first=True)
para(tf, "真实大模型完整交付过一次", 13, FG, space_before=14)
para(tf, "14/14 与 22/22 需求达成，fullyVerified = true，0 技术债", 11, MUTED, space_before=2)
para(tf, "11 条确定性锚点 + 401 个测试守着「检查本身是对的」", 13, FG, space_before=10)
para(tf, "靶场 45 样本零误报", 11, MUTED, space_before=2)
para(tf, "一条可复用的方法论", 13, FG, space_before=10)
para(tf, "先让失败可见，再谈减少失败", 11, MUTED, space_before=2)

p = panel(s, Inches(6.83), Inches(1.95), Inches(5.8), Inches(3.95))
tf = p.text_frame
tf.word_wrap = True
tf.margin_left = Emu(182880)
tf.margin_top = Emu(137160)
tf.vertical_anchor = MSO_ANCHOR.TOP
para(tf, "还没做到（诚实）", 16, WARN, True, first=True)
para(tf, "成功率还不稳定", 13, FG, space_before=14)
para(tf, "四个平行任务里两个交付、一个仍在返工、一个卡在契约一致性", 11, MUTED, space_before=2)
para(tf, "四轮并行只成一，方差还大", 13, FG, space_before=10)
para(tf, "卡点集中在契约生成质量", 11, MUTED, space_before=2)
para(tf, "B1 / B3 在成功那轮是 SKIPPED", 13, FG, space_before=10)
para(tf, "SKIPPED ≠ PASS，所以我们不算它通过", 11, MUTED, space_before=2)

p = panel(s, Inches(0.7), Inches(6.15), Inches(11.93), Inches(0.58), PANEL, ACCENT)
tf = p.text_frame
tf.word_wrap = True
tf.margin_left = Emu(182880)
tf.vertical_anchor = MSO_ANCHOR.MIDDLE
para(tf, "接下来是现场真实运行（3 分钟）—— 不播录屏，直接跑；产物与证据都在仓库里，可当场复核。", 13, ACCENT, True, first=True)
footer(s)

out = r"E:\github\agentforge\docs\competition\AgentForge-赛道B.pptx"
prs.save(out)
print("saved:", out)
print("slides:", len(prs.slides.__iter__.__self__._sldIdLst))
