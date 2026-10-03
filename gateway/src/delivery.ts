// ============================================================
// What happens to a message from Halo once it is stored: get it to the user.
//
// Work package 2 does the first half of the decision: a user with a live connection gets the
// message on it (`socket`); a user with none leaves it `queued`, to be replayed when the app next
// connects (hello with last_seq, or resume). Work package 3 completes the decision: wait for the
// app's acknowledgement, and for a user who is away or does not answer, raise a push through the
// Vircle push API. That change belongs in this one function.
// ============================================================

import { deliverFrame } from './frames'
import type { Hub } from './hub'
import type { Delivery, Message, Store, Subject } from './store'

export async function deliverFromHalo(args: { store: Store; hub: Hub }, subject: Subject, message: Message): Promise<Delivery> {
  const reached = args.hub.send(subject.user.id, deliverFrame(message))
  const delivery: Delivery = reached > 0 ? 'socket' : 'queued'
  await args.store.setDelivery(message.id, delivery)
  return delivery
}
