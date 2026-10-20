import { useEffect, useRef, useState, type ReactNode } from 'react'

export default function DeferredRender({
  children,
  rootMargin = '900px 0px',
}: {
  children: ReactNode
  rootMargin?: string
}) {
  const ref = useRef<HTMLDivElement | null>(null)
  const [shouldRender, setShouldRender] = useState(() =>
    typeof IntersectionObserver === 'undefined',
  )

  useEffect(() => {
    if (shouldRender) return
    const el = ref.current
    if (!el) return
    const observer = new IntersectionObserver((entries) => {
      if (!entries.some((entry) => entry.isIntersecting)) return
      setShouldRender(true)
      observer.disconnect()
    }, { rootMargin })
    observer.observe(el)
    return () => observer.disconnect()
  }, [rootMargin, shouldRender])

  return (
    <div ref={ref}>
      {shouldRender ? children : null}
    </div>
  )
}
