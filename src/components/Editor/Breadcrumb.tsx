import React from 'react'
import { ChevronRight } from 'lucide-react'
import './Breadcrumb.css'

interface BreadcrumbProps {
  path: string
  /** Kept in the component's prop shape so the editor chrome can pass the
   *  current filename even though the current layout doesn't render it —
   *  removing the prop here would force every call site to retype. */
  fileName?: string
}

export const Breadcrumb: React.FC<BreadcrumbProps> = ({ path }) => {
  const parts = path.split('/').filter(Boolean)

  return (
    <div className="breadcrumb">
      {parts.map((part, idx) => (
        <React.Fragment key={idx}>
          {idx > 0 && <ChevronRight size={12} className="breadcrumb-separator" />}
          <span className={idx === parts.length - 1 ? 'breadcrumb-active' : 'breadcrumb-item'}>
            {part}
          </span>
        </React.Fragment>
      ))}
    </div>
  )
}
