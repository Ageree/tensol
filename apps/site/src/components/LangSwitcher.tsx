// English-only product UI; kept as a no-op for existing layout call sites.

type Props = {
  size?: 'sm' | 'md';
  tone?: 'auto' | 'inverse';
};

export function LangSwitcher(_props: Props) {
  return null;
}
