export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: { extend: { colors: {
    background: 'var(--background)', foreground: 'var(--foreground)',
    primary: { DEFAULT: 'var(--primary)', foreground: 'var(--primary-foreground)' },
    secondary: { DEFAULT: 'var(--secondary)', foreground: 'var(--secondary-foreground)' },
    muted: { DEFAULT: 'var(--muted)', foreground: 'var(--muted-foreground)' },
    destructive: 'var(--destructive)', border: 'var(--border)', input: 'var(--input)', ring: 'var(--ring)',
  } } },
};
