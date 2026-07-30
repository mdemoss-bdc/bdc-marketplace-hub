import { cn } from '@/lib/utils';

type BrandLogoProps = {
  className?: string;
  alt?: string;
};

/** High-res app mark from /public/logo.png (1024×1024). */
export function BrandLogo({
  className = 'h-8 w-8',
  alt = 'BDC Manager Desk',
}: BrandLogoProps) {
  return (
    <img
      src="/logo.png"
      alt={alt}
      width={1024}
      height={1024}
      decoding="async"
      className={cn('object-contain select-none', className)}
    />
  );
}
