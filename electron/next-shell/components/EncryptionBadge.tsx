import React from "react";
import { FaLock } from "react-icons/fa6";

export default function EncryptionBadge({
  className = "",
}: {
  className?: string;
}) {
  return (
    <div
      className={`inline-flex items-center px-1.5 py-0.5 rounded text-[9px] font-bold uppercase tracking-wider bg-green-500/10 text-green-600 border border-green-500/20 ${className}`}
      title="End-to-End Encrypted via Signal Protocol"
    >
      <FaLock className="mr-1 text-[8px]" />
      E2E Encrypted
    </div>
  );
}
