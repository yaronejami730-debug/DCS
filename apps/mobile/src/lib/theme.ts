export const theme = {
  color: {
    bg: '#f5f7fa',
    surface: '#ffffff',
    border: '#e2e7ef',
    text: '#131d33',
    muted: '#7c8aa3',
    brand: '#2f5fe0',
    brandSoft: '#eef3ff',
    success: '#0f9d58',
    successSoft: '#e8f6ee',
    warning: '#b7791f',
    warningSoft: '#fdf5e6',
    danger: '#d64545',
    dangerSoft: '#fdeded',
  },
  radius: { sm: 8, md: 12, lg: 16 },
  space: (n: number) => n * 4,
} as const;
