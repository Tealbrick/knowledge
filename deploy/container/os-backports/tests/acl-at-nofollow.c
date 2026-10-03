#define _GNU_SOURCE 1
#include <acl/libacl.h>
#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <errno.h>
#include <sys/acl.h>
#include <sys/stat.h>

static void
fail(const char *message)
{
	fprintf(stderr, "acl-at-nofollow: %s: %s\n", message, strerror(errno));
	exit(EXIT_FAILURE);
}

int
main(void)
{
	char directory[] = "/tmp/acl-at-nofollow.XXXXXX";
	const char *acl_text = "u::rw-,u:65534:r--,g::r--,m::r--,o::---";
	int dirfd = -1;
	acl_t expected = NULL;
	acl_t observed = NULL;
	acl_t link_acl = NULL;
	acl_t default_acl = NULL;
	int status = EXIT_FAILURE;
	int filefd = -1;
	char renamed_directory[sizeof directory + 16];

	if (!mkdtemp(directory))
		fail("mkdtemp");
	dirfd = open(directory, O_RDONLY | O_DIRECTORY | O_CLOEXEC);
	if (dirfd < 0)
		fail("open directory");
	filefd = openat(dirfd, "target", O_CREAT | O_EXCL | O_WRONLY | O_CLOEXEC, 0600);
	if (filefd < 0)
		fail("create target");
	if (close(filefd) != 0)
		fail("close target");
	if (symlinkat("target", dirfd, "link") != 0)
		fail("create symlink");

	expected = acl_from_text(acl_text);
	if (!expected)
		fail("acl_from_text");
	if (acl_valid(expected) != 0)
		fail("acl_valid");
	link_acl = acl_from_text("u::---,g::---,o::---");
	if (!link_acl || acl_valid(link_acl) != 0)
		fail("create different valid symlink ACL");
	default_acl = acl_from_text("u::rwx,g::r-x,o::---");
	if (!default_acl || acl_valid(default_acl) != 0)
		fail("create valid default directory ACL");
	if (acl_set_file_at(dirfd, "target", AT_SYMLINK_NOFOLLOW,
			    ACL_TYPE_ACCESS, expected) != 0)
		fail("acl_set_file_at regular file");
	observed = acl_get_file_at(dirfd, "target", AT_SYMLINK_NOFOLLOW,
				   ACL_TYPE_ACCESS);
	if (!observed)
		fail("acl_get_file_at regular file");
	if (acl_cmp(expected, observed) != 0)
		fail("round-trip ACL mismatch");
	acl_free(observed);
	observed = NULL;
	if (mkdirat(dirfd, "subdir", 0700) != 0)
		fail("create subdirectory");
	if (acl_set_file_at(dirfd, "subdir", 0, ACL_TYPE_DEFAULT, default_acl) != 0)
		fail("set default directory ACL");
	observed = acl_get_file_at(dirfd, "subdir", 0, ACL_TYPE_DEFAULT);
	if (!observed || acl_cmp(default_acl, observed) != 0)
		fail("read default directory ACL");
	acl_free(observed);
	observed = NULL;
	if (acl_delete_def_file_at(dirfd, "subdir", 0) != 0)
		fail("delete default directory ACL");
	observed = acl_get_file_at(dirfd, "subdir", 0, ACL_TYPE_DEFAULT);
	if (!observed || acl_entries(observed) != 0)
		fail("default ACL delete control");
	acl_free(observed);
	observed = NULL;

	errno = 0;
	observed = acl_get_file_at(dirfd, "link", AT_SYMLINK_NOFOLLOW,
				   ACL_TYPE_ACCESS);
	if (observed || (errno != ENOTSUP && errno != EOPNOTSUPP)) {
		if (observed)
			errno = 0;
		fail("nofollow read unexpectedly followed or had unexpected result");
	}

	errno = 0;
	if (acl_set_file_at(dirfd, "link", AT_SYMLINK_NOFOLLOW,
			    ACL_TYPE_ACCESS, link_acl) == 0 ||
	    (errno != ENOTSUP && errno != EOPNOTSUPP))
		fail("nofollow write unexpectedly succeeded or had unexpected result");

	observed = acl_get_file_at(dirfd, "target", AT_SYMLINK_NOFOLLOW,
				   ACL_TYPE_ACCESS);
	if (!observed)
		fail("read target ACL after symlink operations");
	if (acl_cmp(expected, observed) != 0)
		fail("nofollow symlink operation changed target ACL");
	acl_free(observed);
	observed = NULL;

	if (snprintf(renamed_directory, sizeof renamed_directory, "%s-renamed", directory)
	    >= (int)sizeof renamed_directory)
		fail("renamed directory path too long");
	if (rename(directory, renamed_directory) != 0)
		fail("rename anchored directory");
	observed = acl_get_file_at(dirfd, "target", AT_SYMLINK_NOFOLLOW,
				   ACL_TYPE_ACCESS);
	if (!observed || acl_cmp(expected, observed) != 0)
		fail("descriptor-relative ACL lookup after path rename");
	status = EXIT_SUCCESS;

	if (observed)
		acl_free(observed);
	if (expected)
		acl_free(expected);
	if (link_acl)
		acl_free(link_acl);
	if (default_acl)
		acl_free(default_acl);
	if (dirfd >= 0) {
		unlinkat(dirfd, "link", 0);
		unlinkat(dirfd, "target", 0);
		unlinkat(dirfd, "subdir", AT_REMOVEDIR);
		close(dirfd);
	}
	if (access(renamed_directory, F_OK) == 0)
		rmdir(renamed_directory);
	else
		rmdir(directory);
	return status;
}
