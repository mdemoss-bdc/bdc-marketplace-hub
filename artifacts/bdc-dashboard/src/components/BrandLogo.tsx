import { cn } from '@/lib/utils';

type BrandLogoProps = {
  className?: string;
  alt?: string;
};

/** High-res app mark from /public/logo.png (1024×1024). */
export function BrandLogo({
  className = 'h-8 w-8',
  alt = 'BDC Manager | Sales Command Center',
}: BrandLogoProps) {
  return (
    <img
      src="/logo.png"
      alt={alt}
      width={1024}
      height={1024}
      decoding="async"
      fetchPriority="high"
      className={cn(
        'object-contain object-center select-none',
        className,
      )}
    />
  );
}
