import React, { forwardRef } from 'react';
import { ProductSessionNotices } from './ProductSessions.jsx';
import { useAppearance } from './useAppearance.js';
import './page-frame.css';

export const PageFrame = forwardRef(function PageFrame({ children, header = null, className = '', contentClassName = '', flow = false, ...props }, ref) {
  const { resolved: theme } = useAppearance();
  return <div data-theme={theme} ref={ref} className={`wm-page-frame${flow ? ' wm-page-frame--flow' : ''} ${className}`} {...props}>
    {header}
    <ProductSessionNotices />
    <div className={`wm-page-content ${contentClassName}`}>{children}</div>
  </div>;
});
