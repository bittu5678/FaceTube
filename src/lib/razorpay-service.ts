import { api } from "./api";
import {
  recordNewVideoUpload,
  markVideoPromoted,
  normalizeVideoVisibility,
  type VideoType,
  type ContentType,
  type VideoVisibility,
  type UploadedVideo,
} from "./video-service";

declare global {
  interface Window {
    Razorpay?: new (options: RazorpayOptions) => RazorpayInstance;
  }
}

export interface RazorpayOptions {
  key: string;
  amount: number; // in paise
  currency: string;
  name: string;
  description: string;
  image?: string;
  order_id: string;
  handler: (response: RazorpayPaymentSuccessResponse) => void;
  prefill?: {
    name?: string;
    email?: string;
    contact?: string;
  };
  notes?: Record<string, string>;
  theme?: {
    color?: string;
  };
  modal?: {
    ondismiss?: () => void;
    escape?: boolean;
    backdropclose?: boolean;
  };
}

export interface RazorpayInstance {
  open: () => void;
  on: (event: string, callback: (response: unknown) => void) => void;
}

export interface RazorpayPaymentSuccessResponse {
  razorpay_payment_id: string;
  razorpay_order_id: string;
  razorpay_signature?: string;
}

export type RazorpayCheckoutStage =
  "creating_order" | "loading_gateway" | "opening_gateway" | "verifying";

const RAZORPAY_SCRIPT_URL = "https://checkout.razorpay.com/v1/checkout.js";
const RAZORPAY_SCRIPT_TIMEOUT_MS = 12000;

let scriptLoadPromise: Promise<boolean> | null = null;
let activeCheckoutLock = false;

export function isRazorpayCheckoutActive(): boolean {
  return activeCheckoutLock;
}

export function resetRazorpayClientStateForTests(): void {
  scriptLoadPromise = null;
  activeCheckoutLock = false;
}

function extractGatewayFailureMessage(response: unknown): string {
  const err = (response as { error?: { description?: string; reason?: string; code?: string } })
    ?.error;
  return (
    err?.description ||
    err?.reason ||
    "Payment was declined or interrupted inside Razorpay. Please try again."
  );
}

/**
 * Dynamically loads Razorpay checkout script with singleton deduplication,
 * existing-tag reuse, timeout handling, and clean retry on failure.
 */
export function loadRazorpayScript(timeoutMs = RAZORPAY_SCRIPT_TIMEOUT_MS): Promise<boolean> {
  if (typeof window === "undefined") {
    return Promise.resolve(false);
  }
  if (window.Razorpay) {
    return Promise.resolve(true);
  }
  if (typeof document === "undefined") {
    return Promise.resolve(false);
  }
  if (scriptLoadPromise) {
    return scriptLoadPromise;
  }

  scriptLoadPromise = new Promise<boolean>((resolve) => {
    let settled = false;
    let existingScript =
      typeof document.querySelector === "function"
        ? (document.querySelector(
            `script[src="${RAZORPAY_SCRIPT_URL}"]`,
          ) as HTMLScriptElement | null)
        : null;

    const cleanupAndResolve = (ok: boolean, removeFailedScript: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (existingScript) {
        existingScript.onload = null;
        existingScript.onerror = null;
        if (removeFailedScript && typeof existingScript.remove === "function") {
          existingScript.remove();
        }
      }
      scriptLoadPromise = null;
      resolve(ok);
    };

    const timer = setTimeout(() => {
      cleanupAndResolve(false, true);
    }, timeoutMs);

    if (existingScript) {
      if (window.Razorpay) {
        cleanupAndResolve(true, false);
        return;
      }
      existingScript.onload = () => cleanupAndResolve(Boolean(window.Razorpay), !window.Razorpay);
      existingScript.onerror = () => cleanupAndResolve(false, true);
      return;
    }

    const script = document.createElement("script");
    existingScript = script;
    script.src = RAZORPAY_SCRIPT_URL;
    script.async = true;
    script.onload = () => cleanupAndResolve(Boolean(window.Razorpay), !window.Razorpay);
    script.onerror = () => cleanupAndResolve(false, true);
    (document.head || document.body).appendChild(script);
  });

  return scriptLoadPromise;
}

/**
 * Non-blocking warm-up so Razorpay checkout.js is cached before "Proceed to Pay" is clicked.
 */
export function preloadRazorpayScript(): void {
  if (typeof window === "undefined" || typeof document === "undefined") {
    return;
  }
  if (window.Razorpay) {
    return;
  }
  void loadRazorpayScript();
}

export interface PendingPremiumPaymentProof {
  videoId: string;
  orderId: string;
  paymentId: string;
  signature: string;
  verified?: boolean | undefined;
}

export interface PremiumPaymentFailureMeta {
  status?: number | undefined;
  stage: "auth" | "order" | "gateway" | "verify" | "video_create";
}

export function shouldClearPendingPremiumPaymentOnFailure(
  meta?: PremiumPaymentFailureMeta,
  errorMsg?: string,
): boolean {
  if (!meta || meta.stage !== "verify") {
    return false;
  }
  if (meta.status === 403 || meta.status === 404 || meta.status === 409) {
    return true;
  }
  if (meta.status === 400 && /signature|status is not successful|mismatch/i.test(errorMsg || "")) {
    return true;
  }
  return false;
}

export interface InitiatePremiumVideoPaymentParams {
  userId?: string;
  uploaderUserId?: string;
  userName?: string;
  uploaderName?: string;
  userEmail?: string;
  userMobile?: string;
  title?: string;
  videoTitle?: string;
  description?: string;
  videoUrl: string;
  thumbnailUrl?: string;
  category?: string;
  duration?: string;
  videoId?: string;
  videoType?: VideoType;
  contentType: ContentType; // "short" | "long"
  visibility?: VideoVisibility;
  directReferrerId?: string | null;
  pendingPayment?:
    | {
        orderId: string;
        paymentId: string;
        signature: string;
        verified?: boolean | undefined;
      }
    | undefined;
  onPaymentCaptured?: (proof: PendingPremiumPaymentProof) => void;
  onPaymentVerified?: (proof: PendingPremiumPaymentProof) => void;
  onStageChange?: (stage: RazorpayCheckoutStage) => void;
  onSuccess: (paymentIdOrVideo: unknown, createdVideo?: UploadedVideo) => void;
  onFailure: (errorMsg: string, meta?: PremiumPaymentFailureMeta) => void;
  onCancel?: () => void;
}

/**
 * Initiates Razorpay payment flow for Premium Video Upload (₹6 total deduction)
 * Uniform split: ₹1.00 Referral, ₹1.00 Admin, ₹3.00 Global Pool, ₹0.90 GST + ₹0.10 PG Fee
 */
export async function initiatePremiumVideoPayment(
  params: InitiatePremiumVideoPaymentParams,
): Promise<void> {
  if (activeCheckoutLock) {
    return;
  }
  activeCheckoutLock = true;

  const effectiveUserId = (params.userId || params.uploaderUserId || "").trim();
  if (!effectiveUserId) {
    activeCheckoutLock = false;
    params.onFailure("Authentication required. Please log in before uploading a Sponsor video.", {
      stage: "auth",
    });
    return;
  }
  const effectiveUserName =
    (params.userName || params.uploaderName || "").trim() || "FaceTube Creator";
  const effectiveTitle = params.title || params.videoTitle || "Untitled Premium Video";
  const effectiveDescription = params.description || "";
  const effectiveVideoId =
    params.videoId || `vid-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`;

  const finalizeCapturedPayment = async (
    paymentId: string,
    orderId: string,
    signature: string | undefined,
    alreadyVerified: boolean,
  ): Promise<void> => {
    params.onStageChange?.("verifying");

    if (!orderId || !paymentId || !signature) {
      activeCheckoutLock = false;
      params.onFailure(
        "Payment signature missing from Razorpay checkout response. Verification aborted.",
        { stage: "verify" },
      );
      return;
    }

    let currentStage: "verify" | "video_create" = alreadyVerified ? "video_create" : "verify";

    try {
      if (!alreadyVerified) {
        // Emit captured payment proof immediately so the caller retains orderId/paymentId/signature
        // across verification errors (e.g., 503 reserve migration / network drops). Never log signature.
        params.onPaymentCaptured?.({
          videoId: effectiveVideoId,
          orderId,
          paymentId,
          signature,
          verified: false,
        });

        // Server-side cryptographic HMAC & API verification
        const res = await api.payments.verify({
          orderId,
          paymentId,
          signature,
          userId: effectiveUserId,
          userName: effectiveUserName,
          videoId: effectiveVideoId,
          purpose: "premium_video_upload",
          referrerUserId: params.directReferrerId ?? null,
        });

        if (!res?.verified) {
          activeCheckoutLock = false;
          params.onFailure(res?.error || "Payment verification failed on the server.", {
            stage: "verify",
          });
          return;
        }

        params.onPaymentVerified?.({
          videoId: effectiveVideoId,
          orderId,
          paymentId,
          signature,
          verified: true,
        });
      }

      currentStage = "video_create";

      // 3. Save uploaded video with verified paid status
      const newVideo = await recordNewVideoUpload({
        id: effectiveVideoId,
        userId: effectiveUserId,
        creatorName: effectiveUserName,
        title: effectiveTitle,
        description: effectiveDescription,
        videoUrl: params.videoUrl,
        ...(params.thumbnailUrl !== undefined && { thumbnailUrl: params.thumbnailUrl }),
        category: params.category || "General",
        videoType: "premium",
        contentType: params.contentType,
        ...(params.duration !== undefined && { duration: params.duration }),
        paymentStatus: "paid",
        paymentId,
        paymentAmount: 6,
        visibility: normalizeVideoVisibility(params.visibility, "public"),
      });

      // 4. Financial distribution (Referral, Admin, GST+PG, Global Pool) is settled authoritatively on the server during api.payments.verify

      activeCheckoutLock = false;
      params.onSuccess(paymentId, newVideo);
    } catch (err: any) {
      const status = typeof err?.status === "number" ? err.status : undefined;
      console.error("Error finalizing premium payment:", err?.message || "Verification failed");
      activeCheckoutLock = false;
      params.onFailure(err?.message || "Failed to complete payment verification on server.", {
        status,
        stage: currentStage,
      });
    }
  };

  try {
    // Safe retry path: resume verification / video creation using captured payment proof
    // without creating a new Razorpay order or reopening Razorpay checkout.
    if (params.pendingPayment) {
      await finalizeCapturedPayment(
        params.pendingPayment.paymentId,
        params.pendingPayment.orderId,
        params.pendingPayment.signature,
        Boolean(params.pendingPayment.verified),
      );
      return;
    }

    // Warm SDK download in parallel with server order creation (no sequential waterfall)
    const scriptPromise = loadRazorpayScript();
    params.onStageChange?.("creating_order");

    // 1. Create real Order via server API (fails closed if credentials or reserve schema missing)
    let orderData: {
      orderId: string;
      amount: number;
      amountInSubunits: number;
      currency: string;
      keyId: string;
    };

    try {
      const res = await api.payments.createOrder({
        purpose: "premium_video_upload",
        userId: effectiveUserId,
        userName: effectiveUserName,
        videoId: effectiveVideoId,
        contentType: params.contentType,
      });

      if (!res?.orderId || !res?.keyId) {
        throw new Error(
          (res as any)?.error ||
            "Server did not return a valid Razorpay order ID or Key ID. Please check server Razorpay configuration.",
        );
      }

      orderData = {
        orderId: res.orderId,
        amount: res.amount,
        amountInSubunits: res.amountInSubunits || Math.round(res.amount * 100),
        currency: res.currency,
        keyId: res.keyId,
      };
    } catch (orderErr: any) {
      activeCheckoutLock = false;
      params.onFailure(
        orderErr?.message ||
          "Could not create Razorpay payment order. Real Razorpay credentials (RAZORPAY_KEY_ID & RAZORPAY_KEY_SECRET) must be configured in server environment.",
        {
          status: typeof orderErr?.status === "number" ? orderErr.status : undefined,
          stage: "order",
        },
      );
      return;
    }

    if (!window.Razorpay) {
      params.onStageChange?.("loading_gateway");
    }
    const scriptLoaded = await scriptPromise;
    if (!scriptLoaded || !window.Razorpay) {
      activeCheckoutLock = false;
      params.onFailure(
        "Razorpay checkout SDK could not be loaded. Please check your internet connection and try again.",
        { stage: "gateway" },
      );
      return;
    }

    // 2. Setup checkout handler with duplicate completion protection
    let completionStarted = false;
    let lastGatewayFailure: string | null = null;

    const handlePaymentCompletion = async (
      paymentId: string,
      orderId: string,
      signature?: string,
    ) => {
      if (completionStarted) {
        return;
      }
      completionStarted = true;
      await finalizeCapturedPayment(paymentId, orderId, signature, false);
    };

    const options: RazorpayOptions = {
      key: orderData.keyId,
      amount: orderData.amountInSubunits,
      currency: "INR",
      name: "FaceTube Creator Studio",
      description: `Premium ${params.contentType === "short" ? "Short" : "Long"} Video Upload (₹5 Base + 18% GST + 2% PG = ₹6 Total)`,
      image: "/favicon.png",
      order_id: orderData.orderId,
      handler: (response) => {
        void handlePaymentCompletion(
          response.razorpay_payment_id,
          response.razorpay_order_id,
          response.razorpay_signature,
        );
      },
      prefill: {
        name: effectiveUserName,
        email: params.userEmail || `${effectiveUserId.toLowerCase()}@facetube.app`,
        contact: params.userMobile || "9999999999",
      },
      theme: {
        color: "#e11d48", // Brand color
      },
      modal: {
        ondismiss: () => {
          if (!completionStarted) {
            activeCheckoutLock = false;
            if (lastGatewayFailure) {
              params.onFailure(lastGatewayFailure, { stage: "gateway" });
            } else if (params.onCancel) {
              params.onCancel();
            }
          }
        },
      },
    };

    params.onStageChange?.("opening_gateway");
    const rzp = new window.Razorpay(options);
    if (typeof rzp.on === "function") {
      rzp.on("payment.failed", (response) => {
        lastGatewayFailure = extractGatewayFailureMessage(response);
      });
    }
    rzp.open();
  } catch (err: any) {
    console.error("Razorpay initiation error:", err?.message || "Initiation error");
    activeCheckoutLock = false;
    params.onFailure(err?.message || "Could not initiate payment gateway.", {
      status: typeof err?.status === "number" ? err.status : undefined,
      stage: "gateway",
    });
  }
}

/**
 * Initiates Razorpay test payment flow for Ads Promotion
 * 7 Days = ₹100 | 15 Days = ₹200 | 1 Month = ₹300 | 1 Year = ₹3,000
 */
export async function initiateAdsPromotionPayment(params: {
  userId: string;
  userName: string;
  userEmail?: string;
  userMobile?: string;
  videoId: string;
  planId: "plan-7-days" | "plan-15-days" | "plan-monthly" | "plan-yearly";
  planName: string;
  durationDays: number;
  price: number;
  directReferrerId?: string | null;
  onStageChange?: (stage: RazorpayCheckoutStage) => void;
  onSuccess: (result: unknown) => void;
  onFailure: (errorMsg: string) => void;
  onCancel?: () => void;
}): Promise<void> {
  if (activeCheckoutLock) {
    return;
  }
  activeCheckoutLock = true;

  try {
    // Warm SDK download in parallel with server order creation
    const scriptPromise = loadRazorpayScript();
    params.onStageChange?.("creating_order");

    let orderData: {
      orderId: string;
      amount: number;
      amountInSubunits: number;
      currency: string;
      keyId: string;
    };

    try {
      const res = await api.payments.createOrder({
        purpose: "ads_promotion",
        userId: params.userId,
        userName: params.userName,
        videoId: params.videoId,
        planId: params.planId,
      });

      if (!res?.orderId || !res?.keyId) {
        throw new Error(
          (res as any)?.error ||
            "Server did not return a valid Razorpay order ID or Key ID. Please check server Razorpay configuration.",
        );
      }

      orderData = {
        orderId: res.orderId,
        amount: res.amount,
        amountInSubunits: res.amountInSubunits || Math.round(res.amount * 100),
        currency: res.currency,
        keyId: res.keyId,
      };
    } catch (orderErr: any) {
      activeCheckoutLock = false;
      params.onFailure(
        orderErr?.message ||
          "Could not create Razorpay payment order. Real Razorpay credentials (RAZORPAY_KEY_ID & RAZORPAY_KEY_SECRET) must be configured in server environment.",
      );
      return;
    }

    if (!window.Razorpay) {
      params.onStageChange?.("loading_gateway");
    }
    const scriptLoaded = await scriptPromise;
    if (!scriptLoaded || !window.Razorpay) {
      activeCheckoutLock = false;
      params.onFailure(
        "Razorpay checkout SDK could not be loaded. Please check your internet connection and try again.",
      );
      return;
    }

    let completionStarted = false;
    let lastGatewayFailure: string | null = null;

    const handleAdsCompletion = async (paymentId: string, orderId: string, signature?: string) => {
      if (completionStarted) {
        return;
      }
      completionStarted = true;
      params.onStageChange?.("verifying");

      if (!signature) {
        activeCheckoutLock = false;
        params.onFailure(
          "Payment signature missing from Razorpay checkout response. Verification aborted.",
        );
        return;
      }

      try {
        const res = await api.payments.verify({
          orderId,
          paymentId,
          signature,
          userId: params.userId,
          videoId: params.videoId,
          purpose: "ads_promotion",
          planId: params.planId,
          metadata: { planId: params.planId },
        });

        if (!res?.verified) {
          activeCheckoutLock = false;
          params.onFailure(res?.error || "Payment verification failed on the server.");
          return;
        }

        // Activate promotion on video (requires backend confirmation)
        await markVideoPromoted({
          videoId: params.videoId,
          planId: params.planId,
          durationDays: params.durationDays,
          paymentId,
        });

        activeCheckoutLock = false;
        params.onSuccess({
          paymentId,
          orderId,
          planId: params.planId,
          days: params.durationDays,
          price: params.price,
        });
      } catch (err: any) {
        console.error("Error completing ads promotion:", err);
        activeCheckoutLock = false;
        params.onFailure(err?.message || "Could not activate promotion.");
      }
    };

    const options: RazorpayOptions = {
      key: orderData.keyId,
      amount: orderData.amountInSubunits,
      currency: "INR",
      name: "FaceTube Ads Promotions",
      description: `Promotion Campaign: ${params.planName} (₹${params.price})`,
      image: "/favicon.png",
      order_id: orderData.orderId,
      handler: (response) => {
        void handleAdsCompletion(
          response.razorpay_payment_id,
          response.razorpay_order_id,
          response.razorpay_signature,
        );
      },
      prefill: {
        name: params.userName,
        email: params.userEmail || `${params.userId.toLowerCase()}@facetube.app`,
        contact: params.userMobile || "9999999999",
      },
      theme: {
        color: "#10b981", // Emerald accent for ads promotion
      },
      modal: {
        ondismiss: () => {
          if (!completionStarted) {
            activeCheckoutLock = false;
            if (lastGatewayFailure) {
              params.onFailure(lastGatewayFailure);
            } else if (params.onCancel) {
              params.onCancel();
            }
          }
        },
      },
    };

    params.onStageChange?.("opening_gateway");
    const rzp = new window.Razorpay(options);
    if (typeof rzp.on === "function") {
      rzp.on("payment.failed", (response) => {
        lastGatewayFailure = extractGatewayFailureMessage(response);
      });
    }
    rzp.open();
  } catch (err: any) {
    console.error("Ads promotion error:", err);
    activeCheckoutLock = false;
    params.onFailure(err?.message || "Could not initiate ads payment gateway.");
  }
}

export interface InitiatePaidSubscriptionPaymentParams {
  userId: string;
  userName?: string;
  userEmail?: string;
  userMobile?: string;
  planId: string;
  planName?: string;
  onStageChange?: (stage: RazorpayCheckoutStage) => void;
  onSuccess: (result: {
    paymentId: string;
    orderId: string;
    subscription?: any;
    message?: string;
  }) => void;
  onFailure: (errorMsg: string) => void;
  onCancel?: () => void;
}

/**
 * Initiates Razorpay payment flow for Paid Subscriber Plans
 * Creator Member (₹49) | VIP Supporter (₹149) | All-Access Annual (₹999)
 * Authority: Backend database resolves actual authoritative price from subscriber_plans
 */
export async function initiatePaidSubscriptionPayment(
  params: InitiatePaidSubscriptionPaymentParams,
): Promise<void> {
  if (activeCheckoutLock) {
    return;
  }
  activeCheckoutLock = true;

  try {
    // Warm SDK download in parallel with server order creation
    const scriptPromise = loadRazorpayScript();
    params.onStageChange?.("creating_order");

    let orderData: {
      orderId: string;
      amount: number;
      amountInSubunits: number;
      currency: string;
      keyId: string;
    };

    try {
      const orderPayload: {
        purpose: "paid_subscription";
        userId: string;
        userName?: string;
        planId: string;
      } = {
        purpose: "paid_subscription",
        userId: params.userId,
        planId: params.planId,
      };
      if (params.userName) {
        orderPayload.userName = params.userName;
      }
      const res = await api.payments.createOrder(orderPayload);

      if (!res?.orderId || !res?.keyId) {
        throw new Error(
          (res as any)?.error ||
            "Server did not return a valid Razorpay order ID or Key ID. Please check server Razorpay configuration.",
        );
      }

      orderData = {
        orderId: res.orderId,
        amount: res.amount,
        amountInSubunits: res.amountInSubunits || Math.round(res.amount * 100),
        currency: res.currency,
        keyId: res.keyId,
      };
    } catch (orderErr: any) {
      activeCheckoutLock = false;
      params.onFailure(
        orderErr?.message ||
          "Could not create Razorpay payment order. Real Razorpay credentials (RAZORPAY_KEY_ID & RAZORPAY_KEY_SECRET) must be configured in server environment.",
      );
      return;
    }

    if (!window.Razorpay) {
      params.onStageChange?.("loading_gateway");
    }
    const scriptLoaded = await scriptPromise;
    if (!scriptLoaded || !window.Razorpay) {
      activeCheckoutLock = false;
      params.onFailure(
        "Razorpay checkout SDK could not be loaded. Please check your internet connection and try again.",
      );
      return;
    }

    let completionStarted = false;
    let lastGatewayFailure: string | null = null;

    const handleSubscriptionCompletion = async (
      paymentId: string,
      orderId: string,
      signature?: string,
    ) => {
      if (completionStarted) {
        return;
      }
      completionStarted = true;
      params.onStageChange?.("verifying");

      if (!signature) {
        activeCheckoutLock = false;
        params.onFailure(
          "Payment signature missing from Razorpay checkout response. Verification aborted.",
        );
        return;
      }

      try {
        const verifyPayload: {
          orderId: string;
          paymentId: string;
          signature: string;
          userId: string;
          userName?: string;
          purpose: "paid_subscription";
          planId: string;
        } = {
          orderId,
          paymentId,
          signature,
          userId: params.userId,
          purpose: "paid_subscription",
          planId: params.planId,
        };
        if (params.userName) {
          verifyPayload.userName = params.userName;
        }
        const res = await api.payments.verify(verifyPayload);

        if (!res?.verified) {
          activeCheckoutLock = false;
          params.onFailure(res?.error || "Payment verification failed on the server.");
          return;
        }

        activeCheckoutLock = false;
        params.onSuccess({
          paymentId,
          orderId,
          subscription: res.subscription,
          message: "Subscription activated successfully!",
        });
      } catch (err: any) {
        console.error("Error finalizing subscription payment:", err);
        activeCheckoutLock = false;
        params.onFailure(err?.message || "Failed to complete subscription verification on server.");
      }
    };

    const options: RazorpayOptions = {
      key: orderData.keyId,
      amount: orderData.amountInSubunits,
      currency: "INR",
      name: "FaceTube Membership",
      description: `${params.planName || "Subscriber Membership"} (${params.planId})`,
      image: "/favicon.png",
      order_id: orderData.orderId,
      handler: (response) => {
        return handleSubscriptionCompletion(
          response.razorpay_payment_id,
          response.razorpay_order_id,
          response.razorpay_signature,
        );
      },
      prefill: {
        ...(params.userName ? { name: params.userName } : {}),
        email: params.userEmail || `${params.userId.toLowerCase()}@facetube.app`,
        contact: params.userMobile || "9999999999",
      },
      theme: {
        color: "#e11d48", // Brand color
      },
      modal: {
        ondismiss: () => {
          if (!completionStarted) {
            activeCheckoutLock = false;
            if (lastGatewayFailure) {
              params.onFailure(lastGatewayFailure);
            } else if (params.onCancel) {
              params.onCancel();
            }
          }
        },
      },
    };

    params.onStageChange?.("opening_gateway");
    const rzp = new window.Razorpay(options);
    if (typeof rzp.on === "function") {
      rzp.on("payment.failed", (response) => {
        lastGatewayFailure = extractGatewayFailureMessage(response);
      });
    }
    rzp.open();
  } catch (err: any) {
    console.error("Paid subscription initiation error:", err);
    activeCheckoutLock = false;
    params.onFailure(err?.message || "Could not initiate payment gateway.");
  }
}

export interface RecoverCapturedPaymentParams {
  orderId: string;
  paymentId: string;
  videoId: string;
  userId: string;
  title: string;
  videoUrl: string;
  description?: string;
  thumbnailUrl?: string;
  contentType?: "short" | "long";
  category?: string;
  visibility?: "public" | "unlisted" | "private";
  duration?: string;
  creatorName?: string;
}

export interface RecoverCapturedPaymentResult {
  recovered: boolean;
  verified: boolean;
  duplicate?: boolean;
  videoPublished?: boolean;
  alreadyPublished?: boolean;
  paymentId: string;
  orderId: string;
  videoId: string;
  amount: number;
  currency: string;
  txNumber?: number;
  distribution?: any;
  assetPath?: string;
  video?: any;
  missingAsset?: string;
  message?: string;
  error?: string;
}

/**
 * Reconciles a previously captured ₹6 Sponsor Video payment on the server.
 * Never creates a new Razorpay order, opens checkout, captures, or charges again.
 */
export async function recoverCapturedPremiumPayment(
  params: RecoverCapturedPaymentParams,
): Promise<RecoverCapturedPaymentResult> {
  const orderId = String(params.orderId || "").trim();
  const paymentId = String(params.paymentId || "").trim();
  const videoId = String(params.videoId || "").trim();
  const userId = String(params.userId || "").trim();
  const title = String(params.title || "").trim();
  const videoUrl = String(params.videoUrl || "").trim();

  if (!userId) {
    throw new Error("Please sign in to recover your Sponsor payment.");
  }
  if (!orderId || !paymentId || !videoId) {
    throw new Error("Order ID, Payment ID, and Video ID are required for recovery.");
  }
  if (!title) {
    throw new Error("Please enter a video title for publishing.");
  }
  if (!videoUrl) {
    throw new Error("Please provide or upload the original video asset path.");
  }

  return await api.payments.recoverCaptured({
    orderId,
    paymentId,
    videoId,
    userId,
    title,
    videoUrl,
    ...(params.description !== undefined ? { description: params.description } : {}),
    ...(params.thumbnailUrl !== undefined ? { thumbnailUrl: params.thumbnailUrl } : {}),
    ...(params.contentType !== undefined ? { contentType: params.contentType } : {}),
    ...(params.category !== undefined ? { category: params.category } : {}),
    ...(params.visibility !== undefined ? { visibility: params.visibility } : {}),
    ...(params.duration !== undefined ? { duration: params.duration } : {}),
    ...(params.creatorName !== undefined ? { creatorName: params.creatorName } : {}),
  });
}
