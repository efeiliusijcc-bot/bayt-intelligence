import { expect, test } from 'vitest';
import { collectorLabel, collectorReason } from './collector-labels';
test('Chinese Filter labels preserve unknown proper names and handle bounded numeric labels', () => {
  expect(collectorLabel('Last updated')).toBe('简历更新时间');
  expect(collectorLabel('Within last week')).toBe('最近1周');
  expect(collectorLabel('25 - 30 years old')).toBe('25–30岁');
  expect(collectorLabel('2 - 5 Years')).toBe('2–5年');
  expect(collectorLabel('USD 1,500 - USD 2,000')).toBe('1,500 - 2,000 美元');
  expect(collectorLabel('Relevancy')).toBe('相关度');
  expect(collectorLabel('Saudi Aramco')).toBe('Saudi Aramco');
  expect(collectorLabel('new unsupported value')).toBe('new unsupported value');
});

test('known Bayt unsupported reasons are presented in Chinese', () => {
  expect(collectorReason('The control or its options could not be identified reliably')).toBe('无法稳定识别该筛选控件或其选项');
  expect(collectorReason(null)).toBe('当前页面无法稳定识别此控件');
});
