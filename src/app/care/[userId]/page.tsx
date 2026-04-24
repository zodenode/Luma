import { notFound } from "next/navigation";
import {
  getEvents,
  getLatestMemorySnapshot,
  getMemory,
  getMessages,
  getTreatment,
  getUser,
} from "@/lib/store";
import CareLoop from "@/components/CareLoop";

export const dynamic = "force-dynamic";

export default async function CarePage({ params }: { params: { userId: string } }) {
  const user = await getUser(params.userId);
  if (!user) notFound();
  const [treatment, events, messages, memory, snapshot] = await Promise.all([
    getTreatment(params.userId),
    getEvents(params.userId),
    getMessages(params.userId),
    getMemory(params.userId),
    getLatestMemorySnapshot(params.userId),
  ]);

  return (
    <CareLoop
      user={user}
      initialTreatment={treatment}
      initialEvents={events}
      initialMessages={messages}
      initialMemory={memory}
      initialSnapshot={snapshot}
    />
  );
}
