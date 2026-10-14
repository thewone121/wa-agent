/**
 * A phone showing the product doing its one job: a customer asks in Pidgin,
 * the assistant looks up the real price, and an order comes out the other end.
 *
 * Static on purpose. It is illustration, not a live feed, and it must render
 * instantly on the login page before anything else has loaded.
 */

export function PhoneDemo({ store = "Thrill Bites" }: { store?: string }) {
  return (
    <div className="phone" aria-hidden>
      <div className="phone-screen">
        <div className="phone-bar">
          <span className="avatar">{store.trim()[0]?.toUpperCase() ?? "T"}</span>
          <div>
            <strong>{store}</strong>
            <span>online</span>
          </div>
        </div>
        <div className="phone-chat">
          <div className="bubble inbound">
            abeg how much be the bento mini platter?
            <div className="bubble-meta">
              <span>19:56</span>
            </div>
          </div>
          <span className="tool">search_catalogue → ₦30,000</span>
          <div className="bubble outbound">
            Bento mini platter dey for ₦30,000. E good for around 40 guests. You wan order?
            <div className="bubble-meta">
              <span>19:56</span>
            </div>
          </div>
          <div className="bubble inbound">
            yes, 2. deliver am to Ikoyi
            <div className="bubble-meta">
              <span>19:57</span>
            </div>
          </div>
          <span className="tool">place_order → ₦60,000</span>
          <div className="bubble outbound">
            Order confirmed. 2 Bento mini platter, ₦60,000. Your reference na A7F3K2 🙏🏾
            <div className="bubble-meta">
              <span>19:57</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
