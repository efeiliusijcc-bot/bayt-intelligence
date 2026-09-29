// Display-only dictionary. Never use translated labels as Bayt selectors or values.
const labels: Record<string, string> = {
  'Last updated': '简历更新时间', 'Last visited': '最近访问时间', 'Last employer': '最近雇主',
  'Last job title': '最近职位', 'Last job role': '最近职能', 'Last job industry': '最近所属行业',
  'Years of experience': '工作年限', 'Residence location': '现居住地', Nationality: '国籍',
  Gender: '性别', Age: '年龄', Languages: '语言', 'Marital status': '婚姻状况',
  'Driving license country': '驾照签发国家', 'Special needs': '特殊支持需求', 'Visa status': '签证状态',
  'Monthly salary range': '月薪范围', 'Career level': '职业层级', 'Target job location': '期望工作地点',
  'Employment type': '雇佣类型', 'Notice period': '到岗时间', Degree: '学历', Major: '专业',
  Institution: '毕业院校', 'Bayt.com tests': 'Bayt测评', 'CV language': '简历语言',
  'CV completeness': '简历完整度', 'Job hopping': '工作变动频率',
  'Gaps in work experience': '工作经历空档', 'Notes on CVs': '简历备注',
  'Views on CV': '简历查看记录', 'Tags on CV': '简历标签', 'Show only CVs that have': '仅显示包含以下信息的简历',
  'Search tips Search tips': '搜索提示',
  'Within last 3 months': '最近3个月', 'Within last 6 months': '最近6个月',
  'Within last month': '最近1个月', 'Within last week': '最近1周',
  Freelance: '自由职业', Freelancer: '自由职业者', Developer: '开发工程师',
  'Senior Software Engineer': '高级软件工程师', 'Software Developer': '软件开发工程师',
  'Software Engineer': '软件工程师', 'Frontend Developer': '前端开发工程师',
  'Accounting and Auditing': '会计与审计', Engineering: '工程技术',
  'Information Technology': '信息技术', Management: '管理', 'Construction & Building': '建筑与施工',
  'General Engineering Consultancy': '综合工程咨询', 'IT Services': 'IT服务', 'Oil & Gas': '石油与天然气',
  'More than 10 Years': '10年以上', Others: '其他', Egypt: '埃及', India: '印度',
  'Saudi Arabia': '沙特阿拉伯', 'United Arab Emirates': '阿联酋', Pakistan: '巴基斯坦',
  Kuwait: '科威特', Qatar: '卡塔尔', Female: '女性', Male: '男性', 'No preference': '不限',
  Arabic: '阿拉伯语', English: '英语', Hindi: '印地语', Urdu: '乌尔都语', French: '法语',
  Married: '已婚', Single: '未婚', 'Health Condition': '健康状况', 'Learning Disability': '学习障碍',
  'Mobility/Physical Disability': '行动或身体障碍', 'Speech/Communication Impairment': '言语或沟通障碍',
  Citizen: '本国公民', 'No Visa': '无签证', 'Residency Visa (Transferable)': '居留签证（可转移）',
  'Visit Visa': '访问签证', 'Entry level': '初级', 'Mid career': '中级', 'Student/Internship': '学生或实习',
  Contractor: '合同制', 'Full time': '全职', 'Part time': '兼职', Immediately: '立即到岗',
  'Up to 1 month': '1个月内', 'Up to 3 months': '3个月内', 'Up to 6 months': '6个月内',
  "Bachelor's degree": '学士', Diploma: '文凭', 'High school or equivalent': '高中或同等学历',
  "Master's degree": '硕士', 'Civil Engineering': '土木工程', Commerce: '商科',
  'Computer Science': '计算机科学', 'Mechanical Engineering': '机械工程',
  'Basic Computer Skills Test': '基础计算机技能测试', 'Computer Skills Test': '计算机技能测试',
  'English For Business Skills Test': '商务英语技能测试', 'IQ Test': '智力测试',
  Hopper: '频繁变动', Medium: '一般', Stable: '稳定', 'Major gaps exist': '存在较长空档',
  'No Major gaps': '无较长空档', 'CVs with notes': '有备注', 'CVs without notes': '无备注',
  'CVs already viewed': '已查看', 'CVs not viewed': '未查看', 'Contact Revealed': '联系方式已揭示',
  'CVs Without Tags': '无标签', 'Contact information': '联系方式', Experience: '工作经历',
  'Mobile confirmation': '手机已验证', Photo: '照片', Relevance: '相关度', Relevancy: '相关度',
  'Last Update': '最近更新', 'Most relevant': '最相关', 'Most recently updated': '最近更新', 'Newest first': '最新优先',
};
const normalized = new Map(Object.entries(labels).map(([key, value]) => [key.toLowerCase(), value]));
const reasons = new Map([
  ['The control or its options could not be identified reliably', '无法稳定识别该筛选控件或其选项'],
  ['The control could not be opened reliably', '无法稳定打开该筛选控件'],
]);
export function collectorLabel(raw: string): string {
  const text = raw.trim();
  const known = normalized.get(text.toLowerCase());
  if (known) return known;
  const age = text.match(/^(\d+)\s*-\s*(\d+) years old$/i);
  if (age) return `${age[1]}–${age[2]}岁`;
  const experience = text.match(/^(\d+)\s*-\s*(\d+) years$/i);
  if (experience) return `${experience[1]}–${experience[2]}年`;
  const completeness = text.match(/^More than (\d+)%$/i);
  if (completeness) return `超过${completeness[1]}%`;
  if (/^USD [\d,]+ - USD [\d,]+$/.test(text)) return text.replaceAll('USD ', '') + ' 美元';
  return raw;
}

export function collectorReason(raw: string | null | undefined): string {
  if (!raw) return '当前页面无法稳定识别此控件';
  return reasons.get(raw.trim()) || raw;
}
