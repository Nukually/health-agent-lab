export function savedContentSummaryContext(input: {
  savedInterventionMaterialCount: number
  communicationCardCount: number
  medicalDocumentCount: number
}): string {
  return [
    '## 已保存内容摘要',
    `- A 我的跟练卡/跟练视频：${input.savedInterventionMaterialCount} 张。`,
    `- B 我的沟通卡：${input.communicationCardCount} 张。`,
    `- C 病历文档：${input.medicalDocumentCount} 份。`,
    '- 未保存/未收藏内容不是单独类别，而是 saved=no 过滤条件：A 可找回历史发送但未保存的跟练卡/视频，B 可找回历史生成但未保存的沟通卡草稿。',
    '- 如需查看编号或具体内容，调用 saved_content：先 action=list 获取 A-* / B-* / C-* 编号；如果用户要直接看跟练卡/视频，用 action=show 展示；如果只是你自己需要知道具体内容再回答，用 action=read。列表编号后会标注“已保存/未保存”；只有 list 使用 saved 过滤时，后续 read/show 才传同样 saved。资源编号是内部管理信息，最终回复严禁提及。',
    '- 这些是历史/已保存资料，不代表本轮必须读取；用户本轮上传图片时，优先解读当前图片。',
    '- 不要根据摘要臆造标题、报告内容、沟通卡正文、视频链接或跟练步骤。',
  ].join('\n')
}
