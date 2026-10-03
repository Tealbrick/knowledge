#include <config.h>
#include <assert.h>
#include <string.h>

#include "tailor.h"
#include "gzip.h"
#include "lzw.h"

DECLARE(uch, inbuf, INBUFSIZ + INBUF_EXTRA);
DECLARE(uch, outbuf, OUTBUFSIZ + OUTBUF_EXTRA);
DECLARE(ush, d_buf, DIST_BUFSIZE);
DECLARE(uch, window, WSIZE);
DECLARE(ush, prev, 2 * WSIZE);

unsigned insize;
unsigned inptr;

int
fill_inbuf(int eof_ok)
{
	(void)eof_ok;
	return EOF;
}

#include "unlzh.c"

int
main(void)
{
	const size_t count = (2 * NC - 1);
	const ush poison = (ush)0xa5a5;

	memset(prev, 0, sizeof prev);
	for (size_t i = 0; i < count; i++) {
		left[i] = poison;
		right[i] = poison;
	}

	/* The regression sequence has already poisoned these arrays via LZW. */
	huf_decode_start();
	for (size_t i = 0; i < count; i++) {
		if (left[i] != 0 || right[i] != 0)
			return 1;
	}
	return 0;
}
