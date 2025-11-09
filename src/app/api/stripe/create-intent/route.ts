// /src/app/api/stripe/create-intent/route.ts
import { NextRequest, NextResponse } from "next/server";
import Stripe from "stripe";

const stripeSecret = process.env.STRIPE_SECRET_KEY || "";
const stripe = new Stripe(stripeSecret, { apiVersion: "2024-06-20" });

export async function POST(req: NextRequest) {
  try {
    if (!stripeSecret) {
      return NextResponse.json(
        { error: "Missing STRIPE_SECRET_KEY" },
        { status: 500 }
      );
    }

    const body = await req.json().catch(() => null);
    if (!body) {
      return NextResponse.json(
        { error: "Invalid JSON body" },
        { status: 400 }
      );
    }

    const { packageId } = body as { packageId: string };

    // Pricing table (USD cents)
    // NOTE: keep this in sync with the client’s options.
    const PACKAGES: Record<
      string,
      { label: string; hours: number; amount: number }
    > = {
      "1h":   { label: "1 hour",  hours: 1,  amount: 55_00 },
      "5h":   { label: "5 hours", hours: 5,  amount: 265_00 }, // corrected price
      "10h":  { label: "10 hours",hours: 10, amount: 500_00 },
      "20h":  { label: "20 hours",hours: 20, amount: 900_00 },
      "40h":  { label: "40 hours",hours: 40, amount: 1600_00 },
    };

    const pack = PACKAGES[packageId];
    if (!pack) {
      return NextResponse.json(
        { error: "Unknown packageId" },
        { status: 400 }
      );
    }

    const intent = await stripe.paymentIntents.create({
      amount: pack.amount,
      currency: "usd",
      // Automatic payment methods keeps it simple for test mode
      automatic_payment_methods: { enabled: true },
      description: `Apex Tutoring – ${pack.label}`,
      metadata: {
        packageId,
        hours: String(pack.hours),
      },
    });

    return NextResponse.json(
      {
        clientSecret: intent.client_secret,
        hours: pack.hours,
        amount: pack.amount,
      },
      { status: 200 }
    );
  } catch (err: any) {
    console.error("[create-intent] error", err);
    return NextResponse.json(
      { error: err?.message || "Server error" },
      { status: 500 }
    );
  }
}
