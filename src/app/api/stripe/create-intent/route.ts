// src/app/api/stripe/create-intent/route.ts
import { NextRequest, NextResponse } from "next/server";
import Stripe from "stripe";

export const runtime = "nodejs"; // ensure Node runtime for the Stripe server SDK

const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;
if (!STRIPE_SECRET_KEY) {
  // Fail fast at module init if the secret is missing
  throw new Error("Missing STRIPE_SECRET_KEY env var");
}

const stripe = new Stripe(STRIPE_SECRET_KEY); // no apiVersion to avoid TS mismatch

// Keep these in one place so UI + server stay in sync
const PACKAGES: Record<
  string,
  { hours: number; amountUsd: number; label: string }
> = {
  "1h":  { hours: 1,  amountUsd: 55,  label: "1 hour" },
  "5h":  { hours: 5,  amountUsd: 265, label: "5 hours" }, // corrected price
  "10h": { hours: 10, amountUsd: 500, label: "10 hours" },
  "20h": { hours: 20, amountUsd: 900, label: "20 hours" },
  "40h": { hours: 40, amountUsd: 1600, label: "40 hours" },
};

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}));
    const { packageId, customerEmail } = body as {
      packageId?: keyof typeof PACKAGES;
      customerEmail?: string;
    };

    if (!packageId || !PACKAGES[packageId]) {
      return NextResponse.json(
        { error: "Invalid or missing packageId" },
        { status: 400 }
      );
    }

    const pkg = PACKAGES[packageId];

    const intent = await stripe.paymentIntents.create({
      amount: Math.round(pkg.amountUsd * 100), // cents
      currency: "usd",
      receipt_email: customerEmail,
      automatic_payment_methods: { enabled: true },
      metadata: {
        packageId,
        hours: String(pkg.hours),
        label: pkg.label,
      },
    });

    // Return client secret to the client for Elements.confirmPayment
    return NextResponse.json({
      clientSecret: intent.client_secret,
      hours: pkg.hours,
      amountUsd: pkg.amountUsd,
      packageId,
    });
  } catch (err: any) {
    console.error("[stripe:create-intent] error", err);
    return NextResponse.json(
      { error: err?.message ?? "Stripe error" },
      { status: 500 }
    );
  }
}
