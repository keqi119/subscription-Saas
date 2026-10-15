"""Optional browser checks of the local source preview, NOT WeChat DevTools.
Requires Python Playwright and installed Edge. Start npm run preview first.
"""
import json
import sys
from pathlib import Path
from playwright.sync_api import sync_playwright

BASE = sys.argv[1] if len(sys.argv) > 1 else 'http://127.0.0.1:18931'
OUT = Path(__file__).resolve().parents[1] / '.artifacts' / 'visual'
OUT.mkdir(parents=True, exist_ok=True)
checks, errors, external, overflow = [], [], [], []
counter = 0

with sync_playwright() as pw:
    browser = pw.chromium.launch(channel='msedge', headless=True)
    context = browser.new_context(viewport={'width': 390, 'height': 844}, device_scale_factor=1)
    page = context.new_page()
    page.on('pageerror', lambda error: errors.append(str(error)))
    page.on('request', lambda request: external.append(request.url) if not request.url.startswith(BASE + '/') else None)
    page.on('dialog', lambda dialog: dialog.accept())

    def go(route):
        global counter
        counter += 1
        page.goto(BASE + '/phone?check=' + str(counter) + '#/pages/' + route, wait_until='networkidle')
        page.wait_for_timeout(220)
        assert page.locator('.preview-runtime-error').count() == 0

    def check(text):
        for attempt in range(40):
            actual = page.locator('#preview-page').inner_text()
            if ''.join(text.split()) in ''.join(actual.split()):
                break
            page.wait_for_timeout(100)
        assert ''.join(text.split()) in ''.join(actual.split()), text + '\n' + actual
        checks.append(text)

    def button(text):
        page.locator('wx-button').filter(has_text=text).first.click()
        page.wait_for_timeout(220)

    def scenario(name):
        go('settings/index')
        page.locator('.scenario-option[data-id="' + name + '"]').click()
        page.wait_for_timeout(220)

    def shot(name):
        page.screenshot(path=str(OUT / (name + '.png')), full_page=True)
        page.screenshot(path=str(OUT / (name + '-viewport.png')), full_page=False)

    def width_check(label):
        result = page.evaluate('''() => ({width: innerWidth, scroll: document.documentElement.scrollWidth,
          elements: [...document.querySelectorAll('#preview-page *')].filter(e => {
            const r = e.getBoundingClientRect(); return r.width && (r.right > innerWidth + 2 || r.left < -2);
          }).slice(0, 10).map(e => ({tag:e.tagName, cls:e.className, text:e.textContent.slice(0,60)}))})''')
        if result['scroll'] > result['width'] + 2:
            overflow.append({'route': label, **result})
        checks.append('viewport:' + label)

    scenario('new')
    go('home/index')
    check('用车，回归简单。')
    shot('home-390')
    page.locator('#preview-tabs button').filter(has_text='选车').click()
    page.wait_for_timeout(250)
    check('3 台车辆')
    page.get_by_placeholder('搜索品牌或车型').last.fill('不存在的车')
    button('搜索')
    check('还没有匹配的车辆')
    button('查看全部车辆')
    check('3 台车辆')
    page.locator('.brand-chip[data-brand="家庭系列"]').click()
    page.wait_for_timeout(220)
    check('1 台车辆')
    button('清除筛选')
    page.locator('.catalog-card[data-id="demo-sedan"]').click()
    page.wait_for_timeout(220)
    check('选择预设套餐')
    page.locator('.plan-card[data-id="demo-sedan-12"]').click()
    page.wait_for_timeout(100)
    check('¥3,299.00')
    button('费用与使用条件')
    check('不承诺所有费用全包')
    shot('vehicle-390')
    button('申请此方案')
    check('确认意向，提交审核。')
    page.get_by_placeholder('例如：演示用户').last.fill('演示用户')
    page.get_by_placeholder('例如：13800000000').last.fill('13800000000')
    page.locator('input[type=checkbox]').check()
    button('提交审核（演示）')
    check('申请')
    go('application-detail/index')
    check('审核')
    button('取消申请（演示）')
    check('已取消')
    checks.append('apply-and-cancel')

    scenario('confirm')
    go('application-detail/index')
    for label in ['最终方案', '订阅期限', '包含里程', '能源说明', '包含权益']:
        check(label)
    shot('final-plan-390')
    page.locator('input[type=checkbox]').check()
    button('确认最终方案（演示）')
    check('已确认')
    go('records/index?type=orders')
    check('待签约')

    scenario('active')
    go('use/index')
    check('里程')
    shot('use-390')
    go('service/index?type=rescue')
    page.get_by_placeholder('道路、方向、附近地标（示例）').last.fill('演示道路 1 号')
    page.get_by_placeholder('请描述车辆情况和需要的帮助').last.fill('示例车辆无法启动，需要检查。')
    button('添加本地图片')
    check('未上传')
    button('保存演示')
    check('已保存服务记录')
    go('mileage/index')
    page.get_by_placeholder('输入当前读数').last.fill('25100')
    button('添加本地凭证')
    button('保存演示里程记录')
    check('里程复核记录已保存')
    go('handover/index')
    button('展开示例证据')
    button('我已阅读全部示例证据')
    page.locator('[data-value="dispute"]').click()
    page.get_by_placeholder('请输入示例姓名').last.fill('演示用户')
    page.get_by_placeholder('请说明需要核对的项目').last.fill('请核对示例车辆钥匙数量。')
    page.locator('input[type=checkbox]').check()
    button('保存演示异议')
    check('交接意见已保存')
    check('不视为交接完成')

    go('settings/index')
    page.locator('.fault-option[data-id="error"]').click()
    go('catalog/index')
    check('重试')
    go('settings/index')
    page.locator('.fault-option[data-id="none"]').click()
    go('catalog/index')
    check('3 台车辆')
    go('settings/index')
    page.locator('.fault-option[data-id="empty"]').click()
    go('catalog/index')
    check('还没有匹配的车辆')
    go('settings/index')
    page.locator('.fault-option[data-id="none"]').click()
    scenario('confirm')
    routes = ['home/index', 'catalog/index', 'vehicle/index?id=demo-suv',
              'application/index?vehicleId=demo-suv&planId=demo-suv-12',
              'application-detail/index', 'mine/index', 'settings/index']
    for width in [320, 390, 430]:
        page.set_viewport_size({'width': width, 'height': 844})
        for route in routes:
            go(route)
            width_check(str(width) + ':' + route)
        go('home/index')
        shot('home-' + str(width))
    scenario('new')
    page.set_viewport_size({'width': 390, 'height': 844})
    go('home/index')
    shot('home-ready')
    browser.close()

report = {'kind': 'Source preview only; not WeChat DevTools', 'checks': checks,
          'count': len(checks), 'pageErrors': errors, 'externalRequests': external, 'overflow': overflow}
(OUT / 'report.json').write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
print(json.dumps(report, ensure_ascii=True))
assert not errors and not external and not overflow
