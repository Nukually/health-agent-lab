export const MAX_MESSAGE_LENGTH = 100_000
export const MESSAGE_LENGTH_WARNING_THRESHOLD = 95_000

// 常见乳腺癌相关药物全名通常不超过十几个汉字；30 字可覆盖较长通用名/简称组合，同时拦截整句误输入。
export const MEDICATION_CUSTOM_NAME_MAX_LENGTH = 30
