interface CompressImageOptions {
  longImageAspectRatio?: number
  longImageMaxDimension?: number
  longImageTargetShortSide?: number
}

export const DOCUMENT_IMAGE_COMPRESS_OPTIONS = {
  longImageAspectRatio: 3,
  longImageMaxDimension: 8192,
  longImageTargetShortSide: 960,
} satisfies CompressImageOptions

export function getCompressedImageSize(
  sourceWidth: number,
  sourceHeight: number,
  maxDimension: number,
  options: CompressImageOptions = {},
) {
  const longSide = Math.max(sourceWidth, sourceHeight)
  const shortSide = Math.min(sourceWidth, sourceHeight)
  const aspectRatio = longSide / shortSide
  const isLongImage = aspectRatio >= (options.longImageAspectRatio ?? Infinity)
  let resizeMaxDimension = maxDimension

  if (isLongImage && options.longImageTargetShortSide) {
    const targetScale = Math.min(1, options.longImageTargetShortSide / shortSide)
    resizeMaxDimension = Math.max(resizeMaxDimension, Math.round(longSide * targetScale))
  } else if (isLongImage && options.longImageMaxDimension) {
    resizeMaxDimension = Math.max(resizeMaxDimension, options.longImageMaxDimension)
  }

  if (isLongImage && options.longImageMaxDimension) {
    resizeMaxDimension = Math.min(resizeMaxDimension, options.longImageMaxDimension)
  }

  if (longSide <= resizeMaxDimension) {
    return { width: sourceWidth, height: sourceHeight }
  }

  const ratio = resizeMaxDimension / longSide
  return {
    width: Math.round(sourceWidth * ratio),
    height: Math.round(sourceHeight * ratio),
  }
}

/** 通过 Canvas 压缩图片：缩放 + JPEG 质量压缩 */
export function compressImage(
  file: File,
  maxDimension: number = 1024,
  quality: number = 0.8,
  options: CompressImageOptions = {},
): Promise<string> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    const objectUrl = URL.createObjectURL(file)
    let settled = false
    let timer: number

    const settle = (fn: () => void) => {
      if (settled) return
      settled = true
      window.clearTimeout(timer)
      URL.revokeObjectURL(objectUrl)
      fn()
    }

    timer = window.setTimeout(() => {
      settle(() => reject(new Error('图片处理超时，请重试')))
    }, 20_000)

    img.decoding = 'async'
    img.onload = () => {
      try {
        let { width, height } = img
        if (!width || !height) {
          settle(() => reject(new Error('图片尺寸无效')))
          return
        }
        const resized = getCompressedImageSize(width, height, maxDimension, options)
        width = resized.width
        height = resized.height
        const canvas = document.createElement('canvas')
        canvas.width = width
        canvas.height = height
        const ctx = canvas.getContext('2d')
        if (!ctx) {
          settle(() => reject(new Error('当前浏览器不支持图片压缩')))
          return
        }
        ctx.drawImage(img, 0, 0, width, height)

        canvas.toBlob(
          (blob) => {
            if (!blob) {
              settle(() => reject(new Error('图片压缩失败')))
              return
            }
            const reader = new FileReader()
            reader.onload = () => {
              const result = reader.result
              settle(() => {
                if (typeof result === 'string') {
                  resolve(result)
                } else {
                  reject(new Error('图片读取失败'))
                }
              })
            }
            reader.onerror = () => settle(() => reject(new Error('图片读取失败')))
            reader.readAsDataURL(blob)
          },
          'image/jpeg',
          quality,
        )
      } catch (err) {
        settle(() => reject(err instanceof Error ? err : new Error('图片压缩失败')))
      }
    }
    img.onerror = () => settle(() => reject(new Error('图片读取失败')))
    img.src = objectUrl
  })
}
