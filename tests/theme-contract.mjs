import assert from 'node:assert/strict';

export function rgb(color) {
  if (color.startsWith('#')) {
    let hex = color.slice(1);
    if (hex.length <= 4) hex = [...hex].map(value => value + value).join('');
    return hex.slice(0, 6).match(/../g).map(value => parseInt(value, 16));
  }
  const values = color.match(/[\d.]+/g)?.map(Number);
  assert.ok(values?.length >= 3, `Unrecognized color: ${color}`);
  return values.slice(0, 3).map(value => color.startsWith('color(srgb ') ? value * 255 : value);
}

export function neutral(color, label) {
  const channels = rgb(color);
  assert.equal(new Set(channels).size, 1, `${label} must be neutral: ${color}`);
}

export async function neutralTheme(body, { tokens, selectors, surfaces, semantic = [] }) {
  const samples = await body.evaluate((_, { tokens, selectors, semantic }) => {
    const root = getComputedStyle(document.documentElement);
    const colors = Object.fromEntries(tokens.map(name => [name, root.getPropertyValue('--' + name).trim()]));
    for (const selector of ['body', ...selectors]) {
      const element = document.querySelector(selector);
      if (!element) throw new Error(`Missing neutral surface: ${selector}`);
      const style = getComputedStyle(element);
      for (const property of ['color', 'backgroundColor', 'borderTopColor', 'outlineColor']) colors[`${selector}.${property}`] = style[property];
      colors[`${selector}.selection`] = getComputedStyle(element, '::selection').backgroundColor;
      for (const [index, color] of [...style.backgroundImage.matchAll(/rgba?\([^)]*\)|color\(srgb [^)]*\)/g)].entries()) colors[`${selector}.gradient${index}`] = color[0];
    }
    return { colors, semantic: Object.fromEntries(semantic.map(name => [name, root.getPropertyValue('--' + name).trim()])) };
  }, { tokens, selectors, semantic });
  for (const [name, color] of Object.entries(samples.colors)) neutral(color, name);
  const luminance = color => rgb(color).map(value => value / 255).map(value => value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4).reduce((sum, value, index) => sum + value * [.2126, .7152, .0722][index], 0);
  for (const foreground of ['text', 'muted', 'accent']) for (const background of surfaces) {
    const levels = [luminance(samples.colors[foreground]), luminance(samples.colors[background])].sort((a, b) => a - b);
    assert.ok((levels[1] + .05) / (levels[0] + .05) >= 4.5, `${foreground} contrast on ${background}`);
  }
  for (const [name, color] of Object.entries(samples.semantic)) assert.ok(new Set(rgb(color)).size > 1, `${name} must retain its functional color`);
  assert.equal(new Set(Object.values(samples.semantic)).size, semantic.length, 'Semantic states must stay distinguishable');
}
