<?php
/**
 * Plugin Name: QA network guard
 * Description: Refuses outbound HTTP to production services from a disposable QA site.
 * Version: 1.0.0
 *
 * QA network guard. Installed only in disposable QA sites (rexenv scratch sites).
 *
 * Refuses outbound HTTP to production services so a test run can never
 * deactivate a real licence, attach to a real service, or purge a real CDN.
 * The project's own hosts come from hosts.txt beside this file, which Miu
 * writes from project.json `live_hosts`; a few shared services are built in.
 * Every refused call is logged to wp-content/qa-blocked-http.log, which the
 * agent reads as evidence ("the plugin tried to reach X at this step").
 *
 * QA_ALLOW_HOSTS (comma separated) lets a run point a host at a local stand-in,
 * for example an app the run starts itself.
 */

defined( 'ABSPATH' ) || exit;

add_filter(
	'pre_http_request',
	static function ( $preempt, $args, $url ) {
		$host = strtolower( (string) wp_parse_url( $url, PHP_URL_HOST ) );
		if ( '' === $host ) {
			return $preempt;
		}
		$allow = array_filter( array_map( 'trim', explode( ',', (string) getenv( 'QA_ALLOW_HOSTS' ) ) ) );
		if ( in_array( $host, $allow, true ) ) {
			return $preempt;
		}
		$blocked = array(
			'api.cloudflare.com',
			'www.googleapis.com',
			'pagespeedonline.googleapis.com',
			'gtmetrix.com',
		);
		$own = __DIR__ . '/hosts.txt';
		if ( is_readable( $own ) ) {
			$blocked = array_merge( $blocked, array_filter( array_map( 'trim', file( $own ) ) ) );
		}
		$hit = false;
		foreach ( $blocked as $b ) {
			if ( $host === $b || substr( $host, -strlen( '.' . $b ) ) === '.' . $b ) {
				$hit = true;
				break;
			}
		}
		if ( ! $hit ) {
			return $preempt;
		}
		$line = sprintf( "%s %s %s\n", gmdate( 'c' ), isset( $args['method'] ) ? $args['method'] : 'GET', $url );
		file_put_contents( WP_CONTENT_DIR . '/qa-blocked-http.log', $line, FILE_APPEND ); // phpcs:ignore WordPress.WP.AlternativeFunctions
		return new WP_Error( 'qa_blocked', 'Blocked by the QA network guard: ' . $host );
	},
	1,
	3
);
