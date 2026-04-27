import { createIntake } from "../src/lib/intake";
import { ingestEvent } from "../src/lib/events";

async function main() {
  console.log("Seeding Luma demo data…");

  const alex = await createIntake({
    name: "Alex Johnson",
    goal: "hormones",
    symptoms: ["low energy", "brain fog", "mood swings"],
    history: "Otherwise healthy. Noticed gradual energy decline over 6 months.",
  });
  console.log("Created user:", alex.id);

  await ingestEvent({
    userId: alex.id,
    type: "consult_completed",
    source: "openloop",
    payload: {
      diagnosis: "Subclinical hormone imbalance",
      plan_summary:
        "8-week protocol: LumaBalance once daily, weekly check-ins, sleep hygiene plan.",
    },
  });

  await ingestEvent({
    userId: alex.id,
    type: "prescription_issued",
    source: "openloop",
    payload: { medication_name: "LumaBalance", dosage: "1 capsule daily" },
  });

  await ingestEvent({
    userId: alex.id,
    type: "medication_shipped",
    source: "pharmacy",
    payload: { carrier: "UPS", tracking: "1Z999AA10123456784" },
  });

  console.log("Seed complete. Visit /care/%s", alex.id);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
