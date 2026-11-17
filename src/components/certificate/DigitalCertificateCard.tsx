import React, { useEffect, useState } from "react";
import QRCode from "qrcode";
import { ShieldCheck, Award, Sparkles, CheckCircle2 } from "lucide-react";
import { FacetubeLogoIcon } from "@/components/videohub/FacetubeLogoIcon";

export interface DigitalCertificateCardProps {
  userName: string;
  userId: string;
  rank: string;
  subscriberCount: string;
  certificateId: string;
  issueDate: string;
  verificationUrl?: string;
  variant?: "full" | "compact";
}

export const DigitalCertificateCard = React.forwardRef<HTMLDivElement, DigitalCertificateCardProps>(
  ({ userName, userId, rank, subscriberCount, certificateId, issueDate, verificationUrl }, ref) => {
    const [qrCodeUrl, setQrCodeUrl] = useState<string>("");

    const verifyLink =
      verificationUrl ||
      (typeof window !== "undefined"
        ? `${window.location.origin}/my-certificate?verify=${encodeURIComponent(certificateId)}`
        : `https://facetube.app/my-certificate?verify=${encodeURIComponent(certificateId)}`);

    useEffect(() => {
      let isMounted = true;
      async function generateQr() {
        try {
          const dataUrl = await QRCode.toDataURL(verifyLink, {
            width: 320,
            margin: 1,
            color: {
              dark: "#0f172a",
              light: "#ffffff",
            },
            errorCorrectionLevel: "H",
          });
          if (isMounted) setQrCodeUrl(dataUrl);
        } catch (err) {
          console.error("Failed to generate QR code for certificate:", err);
        }
      }
      generateQr();
      return () => {
        isMounted = false;
      };
    }, [verifyLink]);

    return (
      <div
        ref={ref}
        id="facetube-digital-certificate"
        className="relative mx-auto w-full max-w-[940px] min-w-[680px] overflow-hidden rounded-2xl bg-[#ffffff] text-slate-900 shadow-xl border-[4px] border-[#c59b27] selection:bg-[#c59b27]/20 [page-break-inside:avoid] [break-inside:avoid]"
        style={{
          boxShadow: "0 15px 40px -10px rgba(0, 0, 0, 0.12), 0 0 30px rgba(197, 155, 39, 0.15)",
          pageBreakInside: "avoid",
          breakInside: "avoid",
        }}
      >
        {/* Ornate Gold Border Inner Inset Frame with Light/White Premium Aesthetic */}
        <div className="m-3 rounded-xl border-2 border-[#c59b27]/60 p-6 sm:p-8 relative bg-gradient-to-b from-[#fdfbf7] via-[#ffffff] to-[#fbf9f4] [page-break-inside:avoid] [break-inside:avoid]">
          {/* Filigree Corner Accents */}
          <div className="absolute top-2 left-2 w-10 h-10 border-t-2 border-l-2 border-[#c59b27] rounded-tl pointer-events-none opacity-90" />
          <div className="absolute top-2 right-2 w-10 h-10 border-t-2 border-r-2 border-[#c59b27] rounded-tr pointer-events-none opacity-90" />
          <div className="absolute bottom-2 left-2 w-10 h-10 border-b-2 border-l-2 border-[#c59b27] rounded-bl pointer-events-none opacity-90" />
          <div className="absolute bottom-2 right-2 w-10 h-10 border-b-2 border-r-2 border-[#c59b27] rounded-br pointer-events-none opacity-90" />

          {/* Light Background Watermark / Logo Pattern */}
          <div className="absolute inset-0 flex items-center justify-center opacity-[0.03] pointer-events-none select-none">
            <FacetubeLogoIcon size={460} />
          </div>

          {/* Top Header: Logo + Accreditation Subtitle */}
          <div className="relative z-10 flex flex-col items-center text-center space-y-2 pb-4 border-b border-[#c59b27]/30">
            <div className="flex items-center gap-2.5">
              <FacetubeLogoIcon size={40} />
              <span className="text-2xl sm:text-3xl font-black tracking-tight text-slate-900">
                Face<span className="text-[#ff3b2e]">Tube</span>
              </span>
            </div>

            <div className="inline-flex items-center gap-2 px-3.5 py-1 rounded-full bg-[#fbf5e6] border border-[#c59b27]/40 text-[11px] sm:text-xs font-bold tracking-[0.2em] text-[#996f12] uppercase shadow-xs">
              <Sparkles className="w-3.5 h-3.5 text-[#b38515]" />
              Official Creator Accreditation
              <Sparkles className="w-3.5 h-3.5 text-[#b38515]" />
            </div>

            <h1 className="text-2xl sm:text-4xl font-extrabold tracking-wider text-[#996f12] pt-1 uppercase font-serif drop-shadow-xs">
              FaceTube Digital Certificate
            </h1>
            <p className="text-xs sm:text-sm text-slate-600 font-medium tracking-wide max-w-xl">
              This credential accreditation is proudly conferred upon the creator below for
              outstanding community excellence, ethical video publishing, and verified subscriber
              milestones.
            </p>
          </div>

          {/* Central Recipient Showcase */}
          <div className="relative z-10 py-5 sm:py-6 text-center space-y-3">
            <span className="text-xs sm:text-sm font-bold uppercase tracking-[0.25em] text-[#996f12]">
              This is to certify that
            </span>

            {/* Recipient Full Name */}
            <div className="py-1">
              <h2 className="text-3xl sm:text-5xl font-black tracking-tight text-slate-900 font-serif">
                {userName || "Alex Rivera"}
              </h2>
              <div className="mx-auto mt-2 h-0.5 w-52 bg-gradient-to-r from-transparent via-[#c59b27] to-transparent" />
            </div>

            {/* Recipient Identification & Recognition Notice */}
            <p className="text-xs sm:text-sm text-slate-600 max-w-2xl mx-auto leading-relaxed px-2">
              has met all governance standards and achieved creator excellence, verified under
              FaceTube creator identity{" "}
              <span className="font-mono font-bold text-[#ff3b2e] bg-red-50 px-2.5 py-0.5 rounded border border-[#ff3b2e]/30">
                {userId || "FT483921"}
              </span>
              . Conferred in recognition of stellar channel growth, creator integrity, and audience
              empowerment.
            </p>
          </div>

          {/* 3-Column Milestone Metric Badges with Light White/Gold Background */}
          <div className="cert-metric-grid relative z-10 grid grid-cols-3 gap-3 sm:gap-4 my-2 [page-break-inside:avoid] [break-inside:avoid]">
            {/* 1. Award / Rank */}
            <div className="rounded-xl border border-[#c59b27]/40 bg-white p-3 sm:p-4 text-center shadow-xs relative overflow-hidden [page-break-inside:avoid] [break-inside:avoid]">
              <div className="absolute top-0 left-0 right-0 h-1 bg-gradient-to-r from-[#c59b27] to-[#e6b839]" />
              <div className="text-[10px] sm:text-[11px] font-bold uppercase tracking-wider text-[#996f12]">
                Creator Award / Rank
              </div>
              <div className="mt-1 flex items-center justify-center gap-1.5 text-sm sm:text-lg font-black text-slate-900">
                <Award className="w-4 h-4 sm:w-5 sm:h-5 text-[#b38515] shrink-0" />
                <span className="truncate">{rank || "Gold Creator Award"}</span>
              </div>
              <div className="text-[9px] sm:text-[10px] text-slate-500 mt-0.5 font-medium truncate">
                Official Tier Milestone
              </div>
            </div>

            {/* 2. Subscriber Count */}
            <div className="rounded-xl border border-[#c59b27]/40 bg-white p-3 sm:p-4 text-center shadow-xs relative overflow-hidden [page-break-inside:avoid] [break-inside:avoid]">
              <div className="absolute top-0 left-0 right-0 h-1 bg-gradient-to-r from-[#ff3b2e] to-[#ff6b5e]" />
              <div className="text-[10px] sm:text-[11px] font-bold uppercase tracking-wider text-[#996f12]">
                Subscriber Milestone
              </div>
              <div className="mt-1 flex items-center justify-center gap-1.5 text-sm sm:text-lg font-black text-slate-900">
                <ShieldCheck className="w-4 h-4 sm:w-5 sm:h-5 text-[#ff3b2e] shrink-0" />
                <span className="truncate">{subscriberCount || "100,000"}+ Subs</span>
              </div>
              <div className="text-[9px] sm:text-[10px] text-emerald-700 mt-0.5 font-semibold flex items-center justify-center gap-1 truncate">
                <CheckCircle2 className="w-3 h-3 text-emerald-600 shrink-0" /> Verified Channel
              </div>
            </div>

            {/* 3. Certificate ID & Issue Date */}
            <div className="rounded-xl border border-[#c59b27]/40 bg-white p-3 sm:p-4 text-center shadow-xs relative overflow-hidden [page-break-inside:avoid] [break-inside:avoid]">
              <div className="absolute top-0 left-0 right-0 h-1 bg-gradient-to-r from-blue-500 to-indigo-600" />
              <div className="text-[10px] sm:text-[11px] font-bold uppercase tracking-wider text-[#996f12]">
                Certificate Reference
              </div>
              <div className="mt-1 font-mono text-xs sm:text-sm font-extrabold text-slate-800 tracking-wide truncate">
                {certificateId}
              </div>
              <div className="text-[9px] sm:text-[10px] text-slate-500 mt-0.5 font-medium truncate">
                Issued: {issueDate}
              </div>
            </div>
          </div>

          {/* Bottom Footer: Verification QR Code, Signatures, Gold Medallion */}
          <div className="cert-footer-row relative z-10 mt-5 pt-4 border-t border-[#c59b27]/30 flex flex-row items-center justify-between gap-4 sm:gap-6 [page-break-inside:avoid] [break-inside:avoid]">
            {/* Left: Dynamic QR Code Verification */}
            <div className="flex items-center gap-2.5 sm:gap-3 bg-[#faf8f5] p-2 sm:p-2.5 rounded-xl border border-[#c59b27]/30 shrink-0 [page-break-inside:avoid] [break-inside:avoid]">
              {qrCodeUrl ? (
                <img
                  src={qrCodeUrl}
                  alt="Certificate Verification QR Code"
                  className="w-13 h-13 sm:w-15 sm:h-15 rounded-md bg-white p-0.5 border border-slate-200 shrink-0"
                />
              ) : (
                <div className="w-13 h-13 sm:w-15 sm:h-15 rounded-md bg-slate-200 animate-pulse" />
              )}
              <div className="text-left space-y-0.5">
                <div className="text-[10px] sm:text-[11px] font-black text-[#996f12] uppercase tracking-wider">
                  Scan to Verify
                </div>
                <div className="text-[9px] sm:text-[10px] text-slate-600 max-w-[130px] leading-tight">
                  Cryptographically verified on FaceTube Registry
                </div>
                <div className="text-[8px] sm:text-[9px] font-mono text-slate-500">
                  {certificateId.slice(-12)}
                </div>
              </div>
            </div>

            {/* Middle: Luxury Gold Foil Embossed Verification Seal */}
            <div className="flex flex-col items-center text-center shrink-0 [page-break-inside:avoid] [break-inside:avoid]">
              <div className="relative flex items-center justify-center p-0.5 rounded-full shadow-[0_4px_16px_rgba(180,83,9,0.28),0_1px_3px_rgba(0,0,0,0.12)] transition-transform duration-300 hover:scale-105">
                {/* Outer Glow Halo */}
                <div className="absolute inset-0 rounded-full bg-gradient-to-tr from-[#ca8a04]/20 via-[#fde047]/30 to-[#b45309]/20 blur-[2px]" />
                <svg
                  className="w-14 h-14 sm:w-16 sm:h-16 relative z-10 select-none"
                  viewBox="0 0 100 100"
                  fill="none"
                  xmlns="http://www.w3.org/2000/svg"
                  role="img"
                  aria-label="FaceTube Official Verified Seal"
                >
                  <defs>
                    <linearGradient
                      id="ftSealOuterGold"
                      x1="0"
                      y1="0"
                      x2="100"
                      y2="100"
                      gradientUnits="userSpaceOnUse"
                    >
                      <stop offset="0%" stopColor="#FFF8D6" />
                      <stop offset="22%" stopColor="#FCD34D" />
                      <stop offset="48%" stopColor="#D97706" />
                      <stop offset="72%" stopColor="#FDE68A" />
                      <stop offset="90%" stopColor="#B45309" />
                      <stop offset="100%" stopColor="#78350F" />
                    </linearGradient>
                    <radialGradient
                      id="ftSealRadialGold"
                      cx="44"
                      cy="38"
                      r="58"
                      gradientUnits="userSpaceOnUse"
                    >
                      <stop offset="0%" stopColor="#FFFDF0" />
                      <stop offset="28%" stopColor="#FEF08A" />
                      <stop offset="56%" stopColor="#F59E0B" />
                      <stop offset="84%" stopColor="#B45309" />
                      <stop offset="100%" stopColor="#6B2D05" />
                    </radialGradient>
                    <linearGradient
                      id="ftSealShieldGrad"
                      x1="50"
                      y1="35"
                      x2="50"
                      y2="61"
                      gradientUnits="userSpaceOnUse"
                    >
                      <stop offset="0%" stopColor="#3F1D06" />
                      <stop offset="50%" stopColor="#2A1203" />
                      <stop offset="100%" stopColor="#1C0B01" />
                    </linearGradient>
                    <filter id="ftSealSoftShadow" x="-10%" y="-10%" width="120%" height="120%">
                      <feDropShadow
                        dx="0"
                        dy="1"
                        stdDeviation="1"
                        floodColor="#451a03"
                        floodOpacity="0.35"
                      />
                    </filter>
                  </defs>

                  {/* Outer Coin Edge Ring */}
                  <circle
                    cx="50"
                    cy="50"
                    r="48"
                    fill="url(#ftSealOuterGold)"
                    stroke="#78350F"
                    strokeWidth="0.75"
                  />
                  <circle
                    cx="50"
                    cy="50"
                    r="45.5"
                    fill="none"
                    stroke="#78350F"
                    strokeWidth="1"
                    strokeDasharray="1.2 2.2"
                    opacity="0.6"
                  />

                  {/* Primary Embossed Medallion Disc */}
                  <circle
                    cx="50"
                    cy="50"
                    r="43"
                    fill="url(#ftSealRadialGold)"
                    stroke="#FFFBEB"
                    strokeWidth="1"
                  />
                  <circle
                    cx="50"
                    cy="50"
                    r="40"
                    fill="none"
                    stroke="#78350F"
                    strokeWidth="0.8"
                    strokeDasharray="3.5 1.5"
                    opacity="0.7"
                  />
                  <circle
                    cx="50"
                    cy="50"
                    r="37.5"
                    fill="none"
                    stroke="#FFF7C2"
                    strokeWidth="0.6"
                    opacity="0.8"
                  />

                  {/* Top Text: FACETUBE */}
                  <text
                    x="50"
                    y="25.5"
                    textAnchor="middle"
                    fontFamily="'Plus Jakarta Sans', system-ui, -apple-system, sans-serif"
                    fontSize="7"
                    fontWeight="900"
                    letterSpacing="2.2"
                    fill="#361A03"
                    className="select-none"
                  >
                    FACETUBE
                  </text>

                  {/* Subtle Ornamental Arc Divider */}
                  <path
                    d="M 32 29.5 Q 50 31.5 68 29.5"
                    stroke="#78350F"
                    strokeWidth="0.5"
                    fill="none"
                    opacity="0.6"
                  />

                  {/* Side Decorative Stars */}
                  <g fill="#451A03" opacity="0.9">
                    {/* Left Star */}
                    <polygon points="27,47 28.1,49.2 30.5,49.4 28.7,51 29.2,53.4 27,52.1 24.8,53.4 25.3,51 23.5,49.4 25.9,49.2" />
                    {/* Right Star */}
                    <polygon points="73,47 74.1,49.2 76.5,49.4 74.7,51 75.2,53.4 73,52.1 70.8,53.4 71.3,51 69.5,49.4 71.9,49.2" />
                  </g>

                  {/* Central Shield with Verification Checkmark */}
                  <g filter="url(#ftSealSoftShadow)">
                    {/* Shield Outer Gold Rim */}
                    <path
                      d="M 50 34.5 L 61.5 38 C 61.5 48 57 56.5 50 60.5 C 43 56.5 38.5 48 38.5 38 Z"
                      fill="url(#ftSealShieldGrad)"
                      stroke="#FDE68A"
                      strokeWidth="1.2"
                    />
                    {/* Shield Inner Inset Line */}
                    <path
                      d="M 50 36.8 L 59.2 39.8 C 59.2 47.5 55.4 54.5 50 58 C 44.6 54.5 40.8 47.5 40.8 39.8 Z"
                      fill="none"
                      stroke="#F59E0B"
                      strokeWidth="0.6"
                      opacity="0.85"
                    />
                    {/* Precision Verification Checkmark */}
                    <path
                      d="M 44.2 47.2 L 48.2 51.2 L 55.8 43.6"
                      stroke="#FEF08A"
                      strokeWidth="2.2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      fill="none"
                    />
                  </g>

                  {/* Bottom Text: OFFICIAL */}
                  <text
                    x="50"
                    y="71.5"
                    textAnchor="middle"
                    fontFamily="'Plus Jakarta Sans', system-ui, -apple-system, sans-serif"
                    fontSize="6.5"
                    fontWeight="900"
                    letterSpacing="2.4"
                    fill="#361A03"
                    className="select-none"
                  >
                    OFFICIAL
                  </text>

                  {/* Triple Bottom Accents (Center Star + Flanking Dots) */}
                  <g fill="#451A03" opacity="0.9">
                    <circle cx="43" cy="78" r="1" />
                    <polygon points="50,75.5 50.8,77.2 52.6,77.4 51.2,78.6 51.6,80.4 50,79.4 48.4,80.4 48.8,78.6 47.4,77.4 49.2,77.2" />
                    <circle cx="57" cy="78" r="1" />
                  </g>
                </svg>
              </div>

              {/* Verified Seal Typography */}
              <div className="flex flex-col items-center mt-1.5 sm:mt-2">
                <div className="flex items-center gap-1.5">
                  <span className="h-[1px] w-2.5 sm:w-3.5 bg-gradient-to-r from-transparent via-[#c59b27] to-[#8a5704]" />
                  <span className="text-[8px] sm:text-[9.5px] font-black uppercase tracking-[0.24em] text-[#7a4802] drop-shadow-[0_0.5px_0_rgba(255,255,255,0.8)] font-sans">
                    VERIFIED SEAL
                  </span>
                  <span className="h-[1px] w-2.5 sm:w-3.5 bg-gradient-to-l from-transparent via-[#c59b27] to-[#8a5704]" />
                </div>
                <span className="text-[6.5px] sm:text-[7.5px] font-bold uppercase tracking-[0.16em] text-[#9c6b16] mt-0.5">
                  Official Certification
                </span>
              </div>
            </div>

            {/* Right: Authorized Signature */}
            <div className="flex flex-col items-end text-right space-y-0.5 sm:space-y-1 shrink-0 [page-break-inside:avoid] [break-inside:avoid]">
              <div className="flex items-baseline justify-end gap-1.5 select-none">
                <span
                  className="text-2xl sm:text-3xl text-slate-800 font-normal tracking-wide leading-none"
                  style={{
                    fontFamily: "'Great Vibes', cursive",
                  }}
                >
                  Md Reyaz Alam
                </span>
                <span className="font-sans text-xs sm:text-sm font-semibold text-slate-700 tracking-wide">
                  (CEO)
                </span>
              </div>
              <div className="h-0.5 w-32 sm:w-36 bg-[#c59b27]/80" />
              <div className="text-[11px] sm:text-xs font-bold text-slate-900 tracking-wide">
                Authorized Signature
              </div>
              <div className="text-[9px] sm:text-[10px] text-slate-600 font-medium">
                FaceTube Global Creator Governance Board
              </div>
            </div>
          </div>
        </div>
      </div>
    );
  },
);

DigitalCertificateCard.displayName = "DigitalCertificateCard";
