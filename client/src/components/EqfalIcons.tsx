import React from 'react';

interface IconProps {
  size?: number;
  stroke?: number;
  className?: string;
}

const SVGIcon: React.FC<IconProps & { children: React.ReactNode }> = ({ size = 24, stroke = 2, className, children }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={stroke} strokeLinecap="round" strokeLinejoin="round" className={className}>
    {children}
  </svg>
);

export const IconHome: React.FC<IconProps> = (props) => (
  <SVGIcon {...props}>
    <path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
    <polyline points="9 22 9 12 15 12 15 22" />
  </SVGIcon>
);

export const IconSales: React.FC<IconProps> = (props) => (
  <SVGIcon {...props}>
    <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2z" />
    <path d="M12 6v12" />
    <path d="M9 9h6" />
    <path d="M9 15h6" />
  </SVGIcon>
);

export const IconPurchases: React.FC<IconProps> = (props) => (
  <SVGIcon {...props}>
    <circle cx="9" cy="21" r="1" />
    <circle cx="20" cy="21" r="1" />
    <path d="M1 1h4l2.68 13.39a2 2 0 0 0 2 1.61h9.72a2 2 0 0 0 2-1.61L23 6H6" />
  </SVGIcon>
);

export const IconDocuments: React.FC<IconProps> = (props) => (
  <SVGIcon {...props}>
    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
    <polyline points="14 2 14 8 20 8" />
    <line x1="12" y1="19" x2="12" y2="5" />
    <line x1="9" y1="19" x2="9" y2="5" />
  </SVGIcon>
);

export const IconBanks: React.FC<IconProps> = (props) => (
  <SVGIcon {...props}>
    <path d="M12 2L2 7v3h20V7l-10-5z" />
    <rect x="2" y="10" width="20" height="10" rx="1" />
    <line x1="6" y1="10" x2="6" y2="20" />
    <line x1="12" y1="10" x2="12" y2="20" />
    <line x1="18" y1="10" x2="18" y2="20" />
  </SVGIcon>
);

export const IconObligations: React.FC<IconProps> = (props) => (
  <SVGIcon {...props}>
    <path d="M9 11l3 3L22 4" />
    <path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" />
  </SVGIcon>
);

export const IconAccounting: React.FC<IconProps> = (props) => (
  <SVGIcon {...props}>
    <rect x="3" y="3" width="18" height="18" rx="1" />
    <path d="M9 9h6M9 15h6M9 12h6" />
    <line x1="9" y1="9" x2="9" y2="15" />
  </SVGIcon>
);

export const IconOpeningBalances: React.FC<IconProps> = (props) => (
  <SVGIcon {...props}>
    <path d="M12 2v20" />
    <path d="M19 9H5a2 2 0 0 0-2 2v4a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-4a2 2 0 0 0-2-2z" />
    <circle cx="12" cy="15" r="2" />
  </SVGIcon>
);

export const IconPeriodicAdjustments: React.FC<IconProps> = (props) => (
  <SVGIcon {...props}>
    <circle cx="12" cy="12" r="10" />
    <polyline points="12 6 12 12 16 14" />
  </SVGIcon>
);

export const IconFixedAssets: React.FC<IconProps> = (props) => (
  <SVGIcon {...props}>
    <rect x="2" y="7" width="20" height="14" rx="2" />
    <path d="M16 3v4M12 3v4M8 3v4" />
    <line x1="6" y1="14" x2="18" y2="14" />
  </SVGIcon>
);

export const IconVAT: React.FC<IconProps> = (props) => (
  <SVGIcon {...props}>
    <path d="M3 12h18" />
    <path d="M7 6h10a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2z" />
    <circle cx="12" cy="12" r="3" />
  </SVGIcon>
);

export const IconMonthlyClose: React.FC<IconProps> = (props) => (
  <SVGIcon {...props}>
    <rect x="3" y="4" width="18" height="18" rx="2" />
    <line x1="16" y1="2" x2="16" y2="6" />
    <line x1="8" y1="2" x2="8" y2="6" />
    <line x1="3" y1="10" x2="21" y2="10" />
    <circle cx="12" cy="16" r="2" />
  </SVGIcon>
);

export const IconAnnualClose: React.FC<IconProps> = (props) => (
  <SVGIcon {...props}>
    <rect x="2" y="4" width="20" height="16" rx="2" />
    <path d="M7 9h10" />
    <path d="M7 13h10" />
    <path d="M7 17h4" />
  </SVGIcon>
);

export const IconFiscalYears: React.FC<IconProps> = (props) => (
  <SVGIcon {...props}>
    <circle cx="12" cy="12" r="10" />
    <polyline points="12 7 12 12 15 15" />
  </SVGIcon>
);

export const IconPartners: React.FC<IconProps> = (props) => (
  <SVGIcon {...props}>
    <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
    <circle cx="9" cy="7" r="4" />
    <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
    <path d="M16 3.13a4 4 0 0 1 0 7.75" />
  </SVGIcon>
);

export const IconCompanyProfile: React.FC<IconProps> = (props) => (
  <SVGIcon {...props}>
    <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
    <circle cx="12" cy="7" r="4" />
  </SVGIcon>
);
