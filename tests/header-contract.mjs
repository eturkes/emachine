import assert from 'node:assert/strict';

export async function alignedHeaderLabels(page) {
  await page.locator('.mobile-menu').waitFor({ state: 'visible' });
  await page.locator('.tab').first().waitFor({ state: 'visible' });
  await page.evaluate(() => document.fonts.ready);
  // Equal button boxes do not guarantee that their rendered labels align.
  const labels = await page.locator('.mobile-menu, .tab').evaluateAll(nodes => nodes.map(node => {
    const range = document.createRange();
    range.selectNodeContents(node.firstChild);
    const rect = range.getBoundingClientRect();
    return { text: node.firstChild.textContent, center: rect.y + rect.height / 2 };
  }));
  const [projects, ...tabs] = labels;
  assert.ok(tabs.length > 0, 'The header must contain a view tab.');
  for (const tab of tabs) {
    const offset = Math.abs(projects.center - tab.center);
    assert.ok(offset <= 1, `${projects.text} and ${tab.text} labels differ vertically by ${offset}px (maximum 1px).`);
  }
}
