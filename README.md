# ps5-vision

[![CI](https://github.com/THEMANINHOLLYWOOD/ps5-vision/actions/workflows/ci.yml/badge.svg)](https://github.com/THEMANINHOLLYWOOD/ps5-vision/actions/workflows/ci.yml)

Play your PS5 in a web browser: on a giant virtual screen in Apple Vision Pro,
or on a laptop, tablet or phone. Nothing is installed on the device you play on.

A small bridge runs on a Mac at home. It connects to the PS5 with Remote Play
(the protocol [chiaki-ng](https://github.com/chiaki-ng/chiaki-ng) speaks on the
Steam Deck) and passes the console's video and sound, untouched, to a web page
over WebRTC. The page sends your controller back the other way.

```
PS5  ──Remote Play──▶  Mac (this bridge)  ──WebRTC──▶  any browser on your network
     ◀──controller───                     ◀──controller──  (controller paired to that device)
```

Not affiliated with or endorsed by Sony Interactive Entertainment.

## What you need

- **A PS5** and the PlayStation Network account that is signed in on it.
- **A Mac** on the same network as the PS5. It runs the bridge and has to stay
  awake while you play. It needs [Homebrew](https://brew.sh) and
  [Node.js](https://nodejs.org) 20 or newer.
- **Something to play on**: Safari on Vision Pro, or a current Safari, Chrome,
  Edge or Firefox on anything else on the same network.
- **A controller paired to the device you play on**, not to the PS5. For a
  DualSense: hold **Create + PS** until the light bar flashes, then pick it in
  that device's Bluetooth settings. On a laptop you can also play with the
  keyboard, or click an on-screen controller.

> The PS5 ends a Remote Play session as soon as a controller connected to the
> console itself is switched on. That is the console's rule, so the controller
> has to belong to the device showing the picture.

## Set up (once)

**1. Get the code and build it.** This installs build tools with Homebrew,
downloads chiaki-ng and compiles the helper that talks to the console. It takes
a few minutes.

```bash
git clone https://github.com/THEMANINHOLLYWOOD/ps5-vision.git
cd ps5-vision
npm run setup
```

**2. Get the PS5 ready.**

- Settings > System > Remote Play > turn on **Enable Remote Play**.
- Settings > System > Power Saving > Features Available in Rest Mode > turn on
  **Stay Connected to the Internet** and **Enable Turning On PS5 from Network**,
  so the bridge can wake the console.

**3. Link the Mac to the PS5.** Leave the PS5 switched on, then:

```bash
npm run link
```

It finds the console, has you sign in to PlayStation Network in your own
browser (only to look up your account's numeric ID; your password never goes
through this project), and asks for the 8-digit number from Settings > System >
Remote Play > **Pair Device**. The result is saved in `config/console.json`.
Treat that file like a password: it lets its holder start Remote Play on your
console.

## Play

```bash
npm start
```

It prints addresses like `https://Your-Mac.local:8443/`. Open the **https** one
in the browser you want to play in. The first time, the browser warns that the
connection is not private, because the certificate is one this Mac made for
itself. Choose Show Details > visit this website (Safari) or Advanced > Proceed
(Chrome). The page then asks, once per device, for the 6-digit **access code**
that `npm start` printed. Then press **Play**.

Tap or click the picture to bring up the controls:

| Control | What it does |
| --- | --- |
| Volume slider and speaker button | Volume and mute for the device you are playing on. The PS5's own TV sound is not affected; turn the TV down or off. |
| Refresh | Reconnects the picture in a few seconds if it freezes or lags. The game keeps running. It also happens automatically after a 4-second freeze. |
| PS, Touchpad | On-screen versions of buttons that browsers often keep for themselves. |
| Fullscreen | Fills the screen. |
| Rest mode | Ends the session and puts the PS5 to sleep. |
| End | Ends the session and leaves the PS5 on. |
| Buttons | Shows a controller you can click or tap, for when there is no real one. |
| Keys | Lists the keyboard controls (or press **?**). |

The start screen lets you pick resolution (up to 1080p), frame rate, and
whether your Wi-Fi is strong or weak. "Weak" sends a lighter stream that
glitches less.

### Start it automatically

```bash
npm run autostart
```

Runs the bridge in the background whenever you're logged in to the Mac, so you
never need a Terminal window. `npm run autostart -- status` shows the address
and access code; `npm run autostart -- off` turns it off. The first time,
allow node to find devices on your local network if macOS asks.

While a game is streaming, the bridge keeps the Mac from falling asleep (you
aren't touching it while you play), and lets it sleep again afterwards.

### Playing from a laptop

No controller needed. While the picture is up, the keyboard is the controller:

| Keys | Controller |
| --- | --- |
| Arrow keys | D-pad (move around the PS5's menus) |
| Enter, Space or K | ✕ (select) |
| Backspace, Esc or L | ○ (back) |
| J / I | □ / △ |
| W A S D | Left stick |
| T F G H | Right stick |
| Q / E, Z / C | L1 / R1, L2 / R2 |
| Left Shift / V | L3 / R3 |
| O, U, P, Y | Options, Create, PS button, touchpad press |

Or press **Buttons** for a controller you can click; each button stays down
for as long as you hold it. A real controller works at the same time.

### Other ways to run it

```bash
npm run mac
```

Private mode: only the Mac itself can open the page (`http://localhost:8080/`).
Use this to play on the Mac, or to mirror the Mac into a headset.

```bash
npm run demo
```

Streams a test pattern with a beep through exactly the same path, so you can
check picture, sound and controller before linking a console. Needs `ffmpeg`
(`brew install ffmpeg`).

The page also has a link for viewing an **HDMI capture card** plugged into the
device you are playing on, as a lower-latency alternative that does not use
Remote Play at all.

## The Vision Pro app

There is also a native app for Vision Pro in [`visionos/`](visionos). It plays
the same stream, and adds what a web page can't:

- **Look at your PS5 to connect.** Like connecting to a Mac, a Connect button
  appears over your real PS5 when you look at it; pinch it and the screen
  opens. The room around you stays exactly as it is.
- **A screen you can size.** Drag the corner, or pick Small, Standard, Large or
  Cinema under it. It always keeps the TV's shape.
- **The controller, fully.** The app reads the DualSense itself, so the PS
  button works and rumble reaches your hands.
- **No address or certificate warning.** It finds the bridge on your network
  by itself and trusts only that bridge's own certificate.

To put it on your headset you need a Mac with Xcode and a free Apple account:

1. `npm run vision` opens the project in Xcode.
2. In Xcode, click the PS5Vision project > Signing & Capabilities > pick your
   Team (add your Apple account if none is listed).
3. Turn on Developer Mode on the headset (Settings > Privacy & Security), pick
   it as the run destination in Xcode, and press Run.

Then, with `npm start` running on the Mac: open PS5 Vision, choose **Show the
app where your PS5 is**, drag the blue ring onto the console and press Done.
From then on, opening the app and looking at the PS5 is all it takes. Allow
Local Network access when asked, or the app can't find the bridge.

`ps5vision://connect` opens the screen straight away, for example from a
Shortcut. The project is generated from `visionos/project.yml` with
[XcodeGen](https://github.com/yonaskolb/XcodeGen) if you change its settings.

Optional: a scanned model of your console makes the app find it by sight
instead of by the spot you showed it. Make one with Create ML's Object
Tracking template from a 3D scan of the PS5 (Reality Composer on an iPhone
can make the scan), and add the resulting `.referenceobject` file to the app.

## If something is off

| What you see | What to do |
| --- | --- |
| The session ends when you pick up the controller | The controller is still paired to the PS5 and woke it. Pair it to the device you play on instead (see "What you need"). |
| The page says the access code is not right | Use the code from the bridge's window on the Mac (the line starting "Access code"). After many wrong tries, wait a minute. |
| "No controller" stays grey | Use the `https://` address; browsers hide controllers from plain `http://` pages. Press any button once the stream is up. |
| `npm run link` finds no console | The PS5 must be fully on, not in rest mode. If macOS asks whether Terminal may find devices on your local network, allow it (System Settings > Privacy & Security > Local Network). Or pass the address: `npm run link -- --host 192.168.x.x`. |
| The PS5 shows error CE-110024-8 while linking | Press OK, open Pair Device again, leave that screen up, and run `npm run link` again with the new number. |
| "Another device is already using Remote Play" | Close the PS Remote Play app or Chiaki wherever it is running. |
| "The PS5 system software is newer than this bridge understands" | A PS5 update changed Remote Play. Raise `CHIAKI_TAG` in `scripts/setup.sh` to the newest chiaki-ng release, delete `vendor/` and `.build/`, and run `npm run setup` again. |
| Stutter, blocky picture, or lag | See below. |
| The PS button on the controller opens something on your device | Use the on-screen PS button, the P key, or the Vision Pro app. |
| The Vision Pro app says it is looking for the bridge | Check `npm start` is running, then allow Local Network for PS5 Vision in the headset's Settings > Apps. Or type the address under Bridge address. |

### Making it smooth

Every frame crosses your network twice (PS5 to Mac, Mac to you), so the network
decides how it feels.

1. Plug the PS5 into the router with a cable. This helps the most.
2. Plug the Mac in too (a USB-C Ethernet adapter is enough), or at least keep
   it close to the router on 5 GHz Wi-Fi.
3. On the start screen choose 720p and "Weak or busy" Wi-Fi.
4. If you play in a Vision Pro, disconnect Mac Virtual Display while playing,
   and turn off AirDrop and Handoff on the Mac. They share the Mac's Wi-Fi
   radio with the stream.

## What it does not do (yet)

- **Play away from home.** The bridge only talks to devices on your own
  network. A VPN into your home network (Tailscale, WireGuard) should work in
  principle but is untested.
- HDR, or anything above 1080p60 (Remote Play's ceiling for H.264).
- DualSense haptics, adaptive triggers, motion, touchpad swipes, or the mic.
  Basic rumble is passed through where the browser supports it.
- Run the bridge on Windows or Linux. Only macOS is set up and tested. The
  code is portable; `scripts/setup.sh` is the part that assumes Homebrew.

## Security

The bridge is built for a home network you trust, and adds a few guards so
that being on the Wi-Fi is not enough to take over the console:

- **Access code.** Every device except the Mac itself has to enter the 6-digit
  code the bridge prints when it starts. A device that keeps guessing wrong is
  locked out for a minute at a time. The code is kept in `config/access-code`;
  delete that file to get a new one. `npm start -- --no-code` turns the code
  off.
- **Known addresses only.** The bridge ignores requests that do not use one of
  the Mac's own names or addresses, which stops a malicious web page from
  reaching it through your browser.
- **Encrypted stream.** Video, sound and controller input travel over WebRTC,
  which is always encrypted. The `https://` page uses a certificate made on
  your Mac, which is why browsers warn about it once.
- **Private mode.** `npm run mac` listens only on the Mac itself.
- **Announced, not exposed.** The bridge announces itself on your network with
  Bonjour so the Vision Pro app can find it. The announcement holds its
  address, port, console name and certificate fingerprint; nothing secret.
  Private mode doesn't announce.

Things to keep in mind:

- `config/` holds your console pairing key, the certificate's private key and
  the access code. It is ignored by git. Never share or commit it.
- Do not forward ports 8080 or 8443 from your router to the internet. A
  6-digit code is right for a living room, not for the open internet.
- To report a security problem, please open a private
  [security advisory](https://github.com/THEMANINHOLLYWOOD/ps5-vision/security/advisories/new)
  rather than a public issue.

## How it is put together

- `helper/` A small C program linked against chiaki-ng's library. It links to
  the console and streams from it, writing video, audio and events to stdout.
- `server/` The bridge, in Node.js: runs the helper, serves the page, and
  speaks WebRTC with [node-datachannel](https://github.com/murat-dogan/node-datachannel).
- `web/` The page you play in. Plain HTML, CSS and JavaScript, no build step.
- `visionos/` The Vision Pro app (SwiftUI, RealityKit, ARKit). It shows the
  same page and adds the room, the controller and the screen sizes.
- `scripts/setup.sh` Fetches and builds chiaki-ng and the helper.

`npm test` runs the unit tests. Video is never re-encoded: the PS5's H.264
goes into RTP as it arrives, which is what keeps the bridge cheap and the delay
low.

## License

[AGPL-3.0-only](LICENSE). The helper links against chiaki-ng, which is
AGPL-3.0-only (with an OpenSSL linking exception), so this project carries the
same terms.

"PlayStation", "PS5" and "DualSense" are trademarks of Sony Interactive
Entertainment Inc. This is an independent, unofficial project.
