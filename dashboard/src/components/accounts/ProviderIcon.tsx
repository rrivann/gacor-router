import { useState } from "react";

// Provider logo from /providers/<name>.webp (assets ported from enowx), with
// a letter-badge fallback for providers without an asset. The resolved state
// is remembered module-wide so re-mounts don't re-request a known 404.
const resolved: Record<string, boolean> = {};

export function ProviderIcon({
  provider,
  size = 40,
  className,
}: {
  provider: string;
  size?: number;
  className?: string;
}) {
  const [failed, setFailed] = useState(resolved[provider] === false);

  if (failed) {
    return (
      <div
        className="flex shrink-0 items-center justify-center rounded-xl bg-primary/15 font-bold uppercase text-primary"
        style={{ width: size, height: size, fontSize: size * 0.38 }}
      >
        {provider.slice(0, 2)}
      </div>
    );
  }

  return (
    <img
      src={`/providers/${provider}.webp`}
      alt={provider}
      loading="lazy"
      decoding="async"
      onLoad={() => {
        resolved[provider] = true;
      }}
      onError={() => {
        resolved[provider] = false;
        setFailed(true);
      }}
      className={className ?? "shrink-0 rounded-xl object-contain"}
      style={{ width: size, height: size }}
    />
  );
}
