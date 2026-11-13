// ps5-helper: speaks PlayStation Remote Play (via chiaki-ng's library) and
// passes the console's encoded video/audio straight through on stdout.
//
//   ps5-helper register --host IP --account-id HEX16 --pin 12345678
//   ps5-helper stream   --host IP --regist-key HEX32 --morning HEX32
//                       [--res 1080|720|540|360] [--fps 60|30] [--bitrate KBPS]
//
// The secrets can come from the environment instead of the command line, where
// other users of the machine could read them from the process list:
// PS5_ACCOUNT_ID, PS5_PIN, PS5_REGIST_KEY, PS5_MORNING.
//
// `stream` wire format, both directions: [type:u8][length:u32le][payload].
//
//   helper -> parent (stdout)
//     'H' [ts:u64le µs][SPS/PPS, Annex B]     video parameter sets
//     'V' [ts:u64le µs][access unit, Annex B] one H.264 frame
//     'A' [ts:u64le µs][Opus packet]          one audio frame
//     'E' JSON                                 session event
//   parent -> helper (stdin)
//     'C' buttons:u32 l2:u8 r2:u8 lx:i16 ly:i16 rx:i16 ry:i16   controller state
//     'I'                                      request a keyframe
//     'P' ascii digits                         console login PIN
//     'S'                                      put console in rest mode, then quit
//     'Q'                                      quit
//
// Logs go to stderr.

#include <chiaki/common.h>
#include <chiaki/controller.h>
#include <chiaki/log.h>
#include <chiaki/regist.h>
#include <chiaki/session.h>

#include <ctype.h>
#include <errno.h>
#include <poll.h>
#include <pthread.h>
#include <signal.h>
#include <stdarg.h>
#include <stdatomic.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <unistd.h>

static ChiakiLog g_log;
static pthread_mutex_t g_out_mutex = PTHREAD_MUTEX_INITIALIZER;
static ChiakiSession g_session;
// Guards every use of g_session from the command thread against the main
// thread tearing the session down.
static pthread_mutex_t g_session_mutex = PTHREAD_MUTEX_INITIALIZER;
static bool g_session_usable = false; // between session start and fini
// The stream itself is up. Set from chiaki's event callback, which can run
// with chiaki's own locks held, so it must not wait for g_session_mutex.
static atomic_bool g_session_connected = false;
// Set from a signal handler or a failed write: stop as soon as possible.
static volatile sig_atomic_t g_stop_requested = 0;

// ---------------------------------------------------------------- utilities

static uint64_t now_us(void)
{
	struct timespec ts;
	clock_gettime(CLOCK_MONOTONIC, &ts);
	return (uint64_t)ts.tv_sec * 1000000ull + (uint64_t)ts.tv_nsec / 1000ull;
}

// On a bad connection chiaki reports every lost packet on its own line:
// hundreds a second. They are written from the threads that receive the
// stream, to a pipe the bridge empties no faster than its window can print,
// so writing them all stalls the stream, which loses more packets, which
// logs more. Each kind of message is therefore written once a second, with a
// count of how many more like it there were.
#define LOG_KINDS 24
#define LOG_KIND_PREFIX 20 // messages of one kind differ in the numbers after this
#define LOG_WINDOW_US 1000000ull

typedef struct
{
	char prefix[LOG_KIND_PREFIX + 1];
	char level;
	unsigned repeats; // beyond the first, which was written at once
} LogKind;

static pthread_mutex_t g_log_mutex = PTHREAD_MUTEX_INITIALIZER;
static LogKind g_log_kinds[LOG_KINDS];
static size_t g_log_kind_count = 0;
static unsigned g_log_other = 0; // messages beyond LOG_KINDS different kinds
static uint64_t g_log_window_start = 0;
static bool g_log_everything = false; // --verbose
static unsigned g_log_resent = 0;
#define LOG_RESENT_WORTH_SAYING 100

// Call with g_log_mutex held.
static void log_summarize(void)
{
	for(size_t i = 0; i < g_log_kind_count; i++)
	{
		if(g_log_kinds[i].repeats)
			fprintf(stderr, "[%c] %s... (%u more like this in the last second)\n",
				g_log_kinds[i].level, g_log_kinds[i].prefix, g_log_kinds[i].repeats);
	}
	if(g_log_other)
		fprintf(stderr, "[W] ...and %u other messages\n", g_log_other);
	g_log_kind_count = 0;
	g_log_other = 0;
}

static void log_cb(ChiakiLogLevel level, const char *msg, void *user)
{
	(void)user;
	char level_char = chiaki_log_level_char(level);
	if(g_log_everything)
	{
		fprintf(stderr, "[%c] %s\n", level_char, msg);
		return;
	}
	// chiaki dumps the bytes of messages it doesn't know, without saying what
	// they are: a header row, then rows starting with an offset. Noise here.
	const char *text = msg;
	while(*text == ' ')
		text++;
	if(strncmp(msg, "offset ", 7) == 0 || (text != msg && strspn(text, "0123456789abcdef") > 0 && text[strspn(text, "0123456789abcdef")] == ' '))
		return;
	// The console sends some messages twice when an acknowledgement is slow;
	// chiaki reports each copy as an error. A few a second is normal and not
	// worth a line; a flood means the link is struggling, and is summed up.
	bool resent = strncmp(msg, "Takion dropping data", 20) == 0;
	pthread_mutex_lock(&g_log_mutex);
	uint64_t now = now_us();
	if(now - g_log_window_start >= LOG_WINDOW_US)
	{
		if(g_log_resent >= LOG_RESENT_WORTH_SAYING)
			fprintf(stderr, "[W] the console repeated itself %u times in a second: its link to this Mac is struggling\n", g_log_resent);
		g_log_resent = 0;
		log_summarize();
		g_log_window_start = now;
	}
	if(resent)
	{
		g_log_resent++;
		pthread_mutex_unlock(&g_log_mutex);
		return;
	}
	LogKind *kind = NULL;
	for(size_t i = 0; i < g_log_kind_count && !kind; i++)
	{
		if(strncmp(g_log_kinds[i].prefix, msg, LOG_KIND_PREFIX) == 0)
			kind = &g_log_kinds[i];
	}
	if(kind)
		kind->repeats++;
	else if(g_log_kind_count < LOG_KINDS)
	{
		kind = &g_log_kinds[g_log_kind_count++];
		snprintf(kind->prefix, sizeof(kind->prefix), "%s", msg);
		kind->level = level_char;
		kind->repeats = 0;
		fprintf(stderr, "[%c] %s\n", level_char, msg);
	}
	else
		g_log_other++;
	pthread_mutex_unlock(&g_log_mutex);
}

static int hex_nibble(char c)
{
	if(c >= '0' && c <= '9') return c - '0';
	if(c >= 'a' && c <= 'f') return c - 'a' + 10;
	if(c >= 'A' && c <= 'F') return c - 'A' + 10;
	return -1;
}

// Decodes exactly out_size bytes of hex. Returns false on bad length/characters.
static bool hex_decode(const char *hex, uint8_t *out, size_t out_size)
{
	if(!hex || strlen(hex) != out_size * 2)
		return false;
	for(size_t i = 0; i < out_size; i++)
	{
		int hi = hex_nibble(hex[i * 2]);
		int lo = hex_nibble(hex[i * 2 + 1]);
		if(hi < 0 || lo < 0)
			return false;
		out[i] = (uint8_t)((hi << 4) | lo);
	}
	return true;
}

static void hex_encode(const uint8_t *in, size_t in_size, char *out)
{
	static const char digits[] = "0123456789abcdef";
	for(size_t i = 0; i < in_size; i++)
	{
		out[i * 2] = digits[in[i] >> 4];
		out[i * 2 + 1] = digits[in[i] & 0xf];
	}
	out[in_size * 2] = '\0';
}

// Escapes s into out as JSON string contents (no surrounding quotes).
static void json_escape(const char *s, char *out, size_t out_size)
{
	size_t o = 0;
	for(; s && *s && o + 7 < out_size; s++)
	{
		unsigned char c = (unsigned char)*s;
		if(c == '"' || c == '\\')
		{
			out[o++] = '\\';
			out[o++] = (char)c;
		}
		else if(c < 0x20)
			o += (size_t)snprintf(out + o, out_size - o, "\\u%04x", c);
		else
			out[o++] = (char)c;
	}
	out[o] = '\0';
}

static const char *arg_value(int argc, char **argv, const char *name)
{
	for(int i = 2; i + 1 < argc; i++)
		if(strcmp(argv[i], name) == 0)
			return argv[i + 1];
	return NULL;
}

// A secret given as an option or, preferably, in the environment.
static const char *secret_value(int argc, char **argv, const char *name, const char *env)
{
	const char *value = arg_value(argc, argv, name);
	if(value)
		return value;
	value = getenv(env);
	return value && *value ? value : NULL;
}

static bool arg_flag(int argc, char **argv, const char *name)
{
	for(int i = 2; i < argc; i++)
		if(strcmp(argv[i], name) == 0)
			return true;
	return false;
}

// ------------------------------------------------------------ framed output

static bool write_all(int fd, const uint8_t *buf, size_t size)
{
	while(size > 0)
	{
		ssize_t n = write(fd, buf, size);
		if(n < 0)
		{
			if(errno == EINTR)
				continue;
			return false;
		}
		buf += n;
		size -= (size_t)n;
	}
	return true;
}

// Frames go to the parent through a queue with a thread of its own, so the
// threads that receive the stream never wait for the parent to read. If they
// did, a parent that is busy for a moment (a slow viewer, a busy Mac) would
// stop the stream being received and acknowledged, the console would resend
// everything, and one hiccup would turn into a frozen picture.
typedef struct OutFrame
{
	struct OutFrame *next;
	uint64_t queued_at;
	size_t size;
	uint8_t data[];
} OutFrame;

#define OUT_BEHIND_BYTES (3u * 1024 * 1024) // about 2 seconds of video
#define OUT_BEHIND_US 500000ull              // or frames waiting this long
#define OUT_GIVE_UP_BYTES (32u * 1024 * 1024) // the parent is not reading at all

static OutFrame *g_out_head = NULL;
static OutFrame *g_out_tail = NULL;
static size_t g_out_bytes = 0;
static bool g_out_closing = false;
static bool g_out_broken = false; // the parent is gone; nothing more is written
static pthread_cond_t g_out_cond = PTHREAD_COND_INITIALIZER;

// More is waiting to be written than a viewer could still use.
static bool out_behind(void)
{
	pthread_mutex_lock(&g_out_mutex);
	bool behind = g_out_bytes > OUT_BEHIND_BYTES
		|| (g_out_head && now_us() - g_out_head->queued_at > OUT_BEHIND_US);
	pthread_mutex_unlock(&g_out_mutex);
	return behind;
}

static void *writer_thread(void *user)
{
	(void)user;
	pthread_mutex_lock(&g_out_mutex);
	while(true)
	{
		while(!g_out_head && !g_out_closing)
			pthread_cond_wait(&g_out_cond, &g_out_mutex);
		OutFrame *frame = g_out_head;
		if(!frame)
			break; // closing, and everything has been written
		g_out_head = frame->next;
		if(!g_out_head)
			g_out_tail = NULL;
		g_out_bytes -= frame->size;
		bool write_it = !g_out_broken;
		pthread_mutex_unlock(&g_out_mutex);

		bool ok = !write_it || write_all(STDOUT_FILENO, frame->data, frame->size);
		free(frame);

		pthread_mutex_lock(&g_out_mutex);
		if(!ok)
		{
			// Parent went away: nothing left to stream to. Only leave a note;
			// the command thread does the stopping.
			g_out_broken = true;
			g_stop_requested = 1;
		}
	}
	pthread_mutex_unlock(&g_out_mutex);
	return NULL;
}

// Writes whatever is still queued (the reason the session ended, above all)
// and ends the writer.
static void out_close(pthread_t writer)
{
	pthread_mutex_lock(&g_out_mutex);
	g_out_closing = true;
	pthread_cond_signal(&g_out_cond);
	pthread_mutex_unlock(&g_out_mutex);
	pthread_join(writer, NULL);
}

// Queues one frame: type, length, optional 8-byte timestamp prefix, payload.
static void emit(char type, bool with_ts, const uint8_t *payload, size_t payload_size)
{
	size_t head_size = with_ts ? 13 : 5;
	OutFrame *frame = malloc(sizeof(OutFrame) + head_size + payload_size);
	if(!frame)
		return;
	uint32_t len = (uint32_t)(payload_size + (with_ts ? 8 : 0));
	uint8_t *head = frame->data;
	head[0] = (uint8_t)type;
	head[1] = (uint8_t)(len & 0xff);
	head[2] = (uint8_t)((len >> 8) & 0xff);
	head[3] = (uint8_t)((len >> 16) & 0xff);
	head[4] = (uint8_t)((len >> 24) & 0xff);
	frame->queued_at = now_us();
	if(with_ts)
	{
		for(int i = 0; i < 8; i++)
			head[5 + i] = (uint8_t)((frame->queued_at >> (8 * i)) & 0xff);
	}
	if(payload_size)
		memcpy(frame->data + head_size, payload, payload_size);
	frame->size = head_size + payload_size;
	frame->next = NULL;

	pthread_mutex_lock(&g_out_mutex);
	if(g_out_broken || g_out_bytes > OUT_GIVE_UP_BYTES)
	{
		pthread_mutex_unlock(&g_out_mutex);
		free(frame);
		return;
	}
	if(g_out_tail)
		g_out_tail->next = frame;
	else
		g_out_head = frame;
	g_out_tail = frame;
	g_out_bytes += frame->size;
	pthread_cond_signal(&g_out_cond);
	pthread_mutex_unlock(&g_out_mutex);
}

static void emit_event(const char *fmt, ...)
{
	char buf[1024];
	va_list ap;
	va_start(ap, fmt);
	int n = vsnprintf(buf, sizeof(buf), fmt, ap);
	va_end(ap);
	if(n < 0)
		return;
	if((size_t)n >= sizeof(buf))
		n = sizeof(buf) - 1;
	emit('E', false, (const uint8_t *)buf, (size_t)n);
}

// ------------------------------------------------------------------ stream

// Set while pictures are being left out because the parent is behind; the
// next one that can be shown on its own (a keyframe) ends it.
static bool g_video_skipping = false;
static uint64_t g_video_skip_told_at = 0;

static bool video_cb(uint8_t *buf, size_t buf_size, int32_t frames_lost, bool frame_recovered, void *user)
{
	(void)user;
	(void)frame_recovered;
	if(frames_lost > 0)
		emit_event("{\"type\":\"frames_lost\",\"count\":%d}", (int)frames_lost);
	// chiaki delivers the SPS/PPS as its own "sample" whenever the profile changes;
	// those contain no slice NAL. Tell the parent which is which.
	bool has_slice = false;
	bool keyframe = false;
	for(size_t i = 0; i + 3 < buf_size; i++)
	{
		if(buf[i] == 0 && buf[i + 1] == 0 && buf[i + 2] == 1)
		{
			uint8_t nal_type = buf[i + 3] & 0x1f;
			if(nal_type == 1 || nal_type == 5)
			{
				has_slice = true;
				keyframe = nal_type == 5;
				break;
			}
			i += 2;
		}
	}
	if(has_slice)
	{
		// Pictures the parent would only get late are worth nothing: leave
		// them out until it has caught up, then start again from a keyframe
		// (each picture builds on the one before, so there is no resuming
		// half way). The parent is told, so it can ask the console for one.
		bool behind = out_behind();
		if(g_video_skipping && keyframe && !behind)
			g_video_skipping = false;
		else if(behind)
			g_video_skipping = true;
		if(g_video_skipping)
		{
			uint64_t now = now_us();
			if(!behind && now - g_video_skip_told_at > 700000ull)
			{
				g_video_skip_told_at = now;
				emit_event("{\"type\":\"video_skipped\"}");
			}
			return true;
		}
	}
	emit(has_slice ? 'V' : 'H', true, buf, buf_size);
	return true;
}

static void audio_header_cb(ChiakiAudioHeader *header, void *user)
{
	(void)user;
	emit_event("{\"type\":\"audio_header\",\"channels\":%u,\"rate\":%u,\"frame_size\":%u}",
		(unsigned)header->channels, (unsigned)header->rate, (unsigned)header->frame_size);
}

static void audio_frame_cb(uint8_t *buf, size_t buf_size, void *user)
{
	(void)user;
	// Sound that would be heard late is left out too; its timestamp lets the
	// parent keep what follows in step with the picture.
	if(out_behind())
		return;
	emit('A', true, buf, buf_size);
}

static void event_cb(ChiakiEvent *event, void *user)
{
	(void)user;
	char esc[512];
	switch(event->type)
	{
		case CHIAKI_EVENT_CONNECTED:
			atomic_store(&g_session_connected, true);
			emit_event("{\"type\":\"connected\"}");
			break;
		case CHIAKI_EVENT_LOGIN_PIN_REQUEST:
			emit_event("{\"type\":\"login_pin_request\",\"incorrect\":%s}",
				event->login_pin_request.pin_incorrect ? "true" : "false");
			break;
		case CHIAKI_EVENT_NICKNAME_RECEIVED:
			json_escape(event->server_nickname, esc, sizeof(esc));
			emit_event("{\"type\":\"nickname\",\"name\":\"%s\"}", esc);
			break;
		case CHIAKI_EVENT_RUMBLE:
			emit_event("{\"type\":\"rumble\",\"left\":%u,\"right\":%u}",
				(unsigned)event->rumble.left, (unsigned)event->rumble.right);
			break;
		case CHIAKI_EVENT_QUIT:
			atomic_store(&g_session_connected, false);
			json_escape(event->quit.reason_str ? event->quit.reason_str : "", esc, sizeof(esc));
			emit_event("{\"type\":\"quit\",\"reason\":\"%s\",\"detail\":\"%s\",\"error\":%s}",
				chiaki_quit_reason_string(event->quit.reason), esc,
				chiaki_quit_reason_is_error(event->quit.reason) ? "true" : "false");
			break;
		default:
			break;
	}
}

static bool read_all(int fd, uint8_t *buf, size_t size)
{
	while(size > 0)
	{
		ssize_t n = read(fd, buf, size);
		if(n == 0)
			return false;
		if(n < 0)
		{
			if(errno == EINTR)
				continue;
			return false;
		}
		buf += n;
		size -= (size_t)n;
	}
	return true;
}

static int16_t rd_i16(const uint8_t *p)
{
	return (int16_t)((uint16_t)p[0] | ((uint16_t)p[1] << 8));
}

// Waits for a command to arrive. Returns false when it is time to stop
// instead: a signal came in, or the parent stopped reading our output.
static bool wait_for_command(void)
{
	struct pollfd fd = { .fd = STDIN_FILENO, .events = POLLIN };
	while(!g_stop_requested)
	{
		int r = poll(&fd, 1, 200);
		if(r > 0)
			return true; // data, end of file or an error: read() tells which
		if(r < 0 && errno != EINTR)
			return true;
	}
	return false;
}

static void on_stop_signal(int sig)
{
	(void)sig;
	g_stop_requested = 1;
}

// Reads commands from the parent until stdin closes, then stops the session.
static void *stdin_thread(void *user)
{
	(void)user;
	uint8_t head[5];
	uint8_t payload[256];
	while(wait_for_command() && read_all(STDIN_FILENO, head, sizeof(head)))
	{
		uint32_t len = (uint32_t)head[1] | ((uint32_t)head[2] << 8) | ((uint32_t)head[3] << 16) | ((uint32_t)head[4] << 24);
		if(len > sizeof(payload))
		{
			fprintf(stderr, "[E] oversized command (%u bytes), stopping\n", len);
			break;
		}
		if(len && !read_all(STDIN_FILENO, payload, len))
			break;

		// The main thread destroys the session once it has ended; nothing
		// may touch it after that.
		pthread_mutex_lock(&g_session_mutex);
		if(!g_session_usable)
		{
			pthread_mutex_unlock(&g_session_mutex);
			return NULL;
		}
		bool quit = false;
		switch(head[0])
		{
			case 'C':
			{
				if(len < 14)
					break;
				ChiakiControllerState state;
				chiaki_controller_state_set_idle(&state);
				state.buttons = (uint32_t)payload[0] | ((uint32_t)payload[1] << 8) | ((uint32_t)payload[2] << 16) | ((uint32_t)payload[3] << 24);
				state.l2_state = payload[4];
				state.r2_state = payload[5];
				state.left_x = rd_i16(payload + 6);
				state.left_y = rd_i16(payload + 8);
				state.right_x = rd_i16(payload + 10);
				state.right_y = rd_i16(payload + 12);
				chiaki_session_set_controller_state(&g_session, &state);
				break;
			}
			case 'I':
				// Only meaningful, and only safe, once the stream is up.
				if(atomic_load(&g_session_connected))
					chiaki_session_request_idr(&g_session);
				break;
			case 'P':
				chiaki_session_set_login_pin(&g_session, payload, len);
				break;
			case 'S':
				if(atomic_load(&g_session_connected))
					chiaki_session_goto_bed(&g_session);
				quit = true;
				break;
			case 'Q':
				quit = true;
				break;
			default:
				break;
		}
		pthread_mutex_unlock(&g_session_mutex);
		if(quit)
			break;
	}

	pthread_mutex_lock(&g_session_mutex);
	if(g_session_usable)
		chiaki_session_stop(&g_session);
	pthread_mutex_unlock(&g_session_mutex);
	return NULL;
}

static int cmd_stream(int argc, char **argv)
{
	const char *host = arg_value(argc, argv, "--host");
	const char *regist_key_hex = secret_value(argc, argv, "--regist-key", "PS5_REGIST_KEY");
	const char *morning_hex = secret_value(argc, argv, "--morning", "PS5_MORNING");
	const char *res = arg_value(argc, argv, "--res");
	const char *fps = arg_value(argc, argv, "--fps");
	const char *bitrate = arg_value(argc, argv, "--bitrate");
	if(!host || !regist_key_hex || !morning_hex)
	{
		fprintf(stderr, "stream: --host, --regist-key and --morning are required\n");
		return 2;
	}

	ChiakiConnectInfo info;
	memset(&info, 0, sizeof(info));
	info.ps5 = !arg_flag(argc, argv, "--ps4");
	info.host = host;
	if(!hex_decode(regist_key_hex, (uint8_t *)info.regist_key, sizeof(info.regist_key))
		|| !hex_decode(morning_hex, info.morning, sizeof(info.morning)))
	{
		fprintf(stderr, "stream: --regist-key and --morning must each be 32 hex characters\n");
		return 2;
	}

	ChiakiVideoResolutionPreset res_preset = CHIAKI_VIDEO_RESOLUTION_PRESET_1080p;
	if(res)
	{
		int r = atoi(res);
		if(r == 720) res_preset = CHIAKI_VIDEO_RESOLUTION_PRESET_720p;
		else if(r == 540) res_preset = CHIAKI_VIDEO_RESOLUTION_PRESET_540p;
		else if(r == 360) res_preset = CHIAKI_VIDEO_RESOLUTION_PRESET_360p;
		else if(r != 1080)
		{
			fprintf(stderr, "stream: --res must be 1080, 720, 540 or 360\n");
			return 2;
		}
	}
	ChiakiVideoFPSPreset fps_preset = (fps && atoi(fps) == 30) ? CHIAKI_VIDEO_FPS_PRESET_30 : CHIAKI_VIDEO_FPS_PRESET_60;
	chiaki_connect_video_profile_preset(&info.video_profile, res_preset, fps_preset);
	// Browsers decode H.264 over WebRTC everywhere; H.265 is not reliably available.
	info.video_profile.codec = CHIAKI_CODEC_H264;
	if(bitrate && atoi(bitrate) > 0)
		info.video_profile.bitrate = (unsigned int)atoi(bitrate);
	info.video_profile_auto_downgrade = true;
	info.enable_keyboard = false;
	info.enable_dualsense = false;
	info.packet_loss_max = 0.05;
	info.enable_idr_on_fec_failure = true;

	ChiakiErrorCode err = chiaki_session_init(&g_session, &info, &g_log);
	if(err != CHIAKI_ERR_SUCCESS)
	{
		fprintf(stderr, "stream: session init failed: %s\n", chiaki_error_string(err));
		return 1;
	}

	ChiakiAudioSink sink;
	memset(&sink, 0, sizeof(sink));
	sink.header_cb = audio_header_cb;
	sink.frame_cb = audio_frame_cb;
	chiaki_session_set_audio_sink(&g_session, &sink);
	chiaki_session_set_video_sample_cb(&g_session, video_cb, NULL);
	chiaki_session_set_event_cb(&g_session, event_cb, NULL);

	err = chiaki_session_start(&g_session);
	if(err != CHIAKI_ERR_SUCCESS)
	{
		fprintf(stderr, "stream: session start failed: %s\n", chiaki_error_string(err));
		chiaki_session_fini(&g_session);
		return 1;
	}
	pthread_mutex_lock(&g_session_mutex);
	g_session_usable = true;
	pthread_mutex_unlock(&g_session_mutex);

	// Ctrl-C in the terminal reaches this process as well as the bridge. Stop
	// the session properly instead of dying mid-stream, so the console is told.
	signal(SIGINT, on_stop_signal);
	signal(SIGTERM, on_stop_signal);
	// Closing the Terminal window hangs up on this process too. Without a
	// goodbye the console keeps the session and turns the next one away.
	signal(SIGHUP, on_stop_signal);

	pthread_t writer;
	bool have_writer = pthread_create(&writer, NULL, writer_thread, NULL) == 0;

	pthread_t reader;
	bool have_reader = have_writer && pthread_create(&reader, NULL, stdin_thread, NULL) == 0;
	if(!have_reader)
		chiaki_session_stop(&g_session);

	chiaki_session_join(&g_session);

	// From here the command thread must leave the session alone. It notices
	// within one poll interval at most; it may also be blocked reading a
	// command that never completes, so don't wait for it.
	pthread_mutex_lock(&g_session_mutex);
	g_session_usable = false;
	pthread_mutex_unlock(&g_session_mutex);
	if(have_reader)
		pthread_detach(reader);
	chiaki_session_fini(&g_session);
	if(have_writer)
		out_close(writer);
	return 0;
}

// ---------------------------------------------------------------- register

static pthread_mutex_t g_regist_mutex = PTHREAD_MUTEX_INITIALIZER;
static pthread_cond_t g_regist_cond = PTHREAD_COND_INITIALIZER;
static bool g_regist_done = false;
static bool g_regist_ok = false;

static void regist_cb(ChiakiRegistEvent *event, void *user)
{
	(void)user;
	if(event->type == CHIAKI_REGIST_EVENT_TYPE_FINISHED_SUCCESS && event->registered_host)
	{
		ChiakiRegisteredHost *h = event->registered_host;
		char regist_key[CHIAKI_SESSION_AUTH_SIZE * 2 + 1];
		char morning[sizeof(h->rp_key) * 2 + 1];
		char mac[sizeof(h->server_mac) * 2 + 1];
		char nickname[128];
		hex_encode((const uint8_t *)h->rp_regist_key, CHIAKI_SESSION_AUTH_SIZE, regist_key);
		hex_encode(h->rp_key, sizeof(h->rp_key), morning);
		hex_encode(h->server_mac, sizeof(h->server_mac), mac);
		json_escape(h->server_nickname, nickname, sizeof(nickname));
		printf("{\"ok\":true,\"regist_key\":\"%s\",\"morning\":\"%s\",\"mac\":\"%s\",\"nickname\":\"%s\",\"ps5\":%s}\n",
			regist_key, morning, mac, nickname, chiaki_target_is_ps5(h->target) ? "true" : "false");
		g_regist_ok = true;
	}
	else
	{
		printf("{\"ok\":false,\"reason\":\"%s\"}\n",
			event->type == CHIAKI_REGIST_EVENT_TYPE_FINISHED_CANCELED ? "canceled" : "failed");
	}
	fflush(stdout);
	pthread_mutex_lock(&g_regist_mutex);
	g_regist_done = true;
	pthread_cond_signal(&g_regist_cond);
	pthread_mutex_unlock(&g_regist_mutex);
}

static int cmd_register(int argc, char **argv)
{
	const char *host = arg_value(argc, argv, "--host");
	const char *account_hex = secret_value(argc, argv, "--account-id", "PS5_ACCOUNT_ID");
	const char *pin = secret_value(argc, argv, "--pin", "PS5_PIN");
	if(!host || !account_hex || !pin)
	{
		fprintf(stderr, "register: --host, --account-id and --pin are required\n");
		return 2;
	}

	ChiakiRegistInfo info;
	memset(&info, 0, sizeof(info));
	info.target = arg_flag(argc, argv, "--ps4") ? CHIAKI_TARGET_PS4_10 : CHIAKI_TARGET_PS5_1;
	info.host = host;
	info.broadcast = false;
	info.psn_online_id = NULL;
	if(!hex_decode(account_hex, info.psn_account_id, sizeof(info.psn_account_id)))
	{
		fprintf(stderr, "register: --account-id must be 16 hex characters\n");
		return 2;
	}
	bool pin_ok = strlen(pin) == 8;
	for(size_t i = 0; pin_ok && i < 8; i++)
		pin_ok = isdigit((unsigned char)pin[i]) != 0;
	if(!pin_ok)
	{
		fprintf(stderr, "register: --pin must be the 8 digits shown on the console\n");
		return 2;
	}
	info.pin = (uint32_t)strtoul(pin, NULL, 10);

	ChiakiRegist regist;
	ChiakiErrorCode err = chiaki_regist_start(&regist, &g_log, &info, regist_cb, NULL);
	if(err != CHIAKI_ERR_SUCCESS)
	{
		fprintf(stderr, "register: could not start: %s\n", chiaki_error_string(err));
		return 1;
	}
	pthread_mutex_lock(&g_regist_mutex);
	while(!g_regist_done)
		pthread_cond_wait(&g_regist_cond, &g_regist_mutex);
	pthread_mutex_unlock(&g_regist_mutex);
	chiaki_regist_fini(&regist);
	return g_regist_ok ? 0 : 1;
}

// -------------------------------------------------------------------- main

int main(int argc, char **argv)
{
	signal(SIGPIPE, SIG_IGN);
	if(argc < 2)
	{
		fprintf(stderr, "usage: ps5-helper <register|stream> [options]\n");
		return 2;
	}

	uint32_t mask = CHIAKI_LOG_ALL & ~(CHIAKI_LOG_VERBOSE | CHIAKI_LOG_DEBUG);
	// While streaming, chiaki reports routine traffic (heartbeats, recovered
	// packets) at the info level every few seconds, which buries anything that
	// matters in the bridge's window. --verbose brings it back.
	if(strcmp(argv[1], "stream") == 0)
		mask = CHIAKI_LOG_WARNING | CHIAKI_LOG_ERROR;
	if(arg_flag(argc, argv, "--verbose"))
	{
		mask = CHIAKI_LOG_ALL & ~CHIAKI_LOG_DEBUG;
		g_log_everything = true;
	}
	chiaki_log_init(&g_log, mask, log_cb, NULL);

	ChiakiErrorCode err = chiaki_lib_init();
	if(err != CHIAKI_ERR_SUCCESS)
	{
		fprintf(stderr, "chiaki init failed: %s\n", chiaki_error_string(err));
		return 1;
	}

	if(strcmp(argv[1], "stream") == 0)
		return cmd_stream(argc, argv);
	if(strcmp(argv[1], "register") == 0)
		return cmd_register(argc, argv);

	fprintf(stderr, "unknown command: %s\n", argv[1]);
	return 2;
}
