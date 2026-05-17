/* Probe libm Bessel functions: j0, j1, jn, y0, y1, yn.
 * libm has NO Bessel-I or Bessel-K, NO general-ν, NO complex.
 * Build:  gcc -O2 libm-test-prog.c -lm -o libm-test-prog
 */
#include <math.h>
#include <stdio.h>
int main(void) {
    printf("j0(2.0)    = %.17g\n", j0(2.0));
    printf("j1(2.0)    = %.17g\n", j1(2.0));
    printf("jn(3, 2.0) = %.17g\n", jn(3, 2.0));
    printf("y0(2.0)    = %.17g\n", y0(2.0));
    printf("y1(2.0)    = %.17g\n", y1(2.0));
    printf("yn(2, 1.5) = %.17g\n", yn(2, 1.5));

    /* L7 algorithm-divergence at J_0 zero */
    printf("j0(2.4048255576957727686)         = %.17g\n",
           j0(2.4048255576957727686));

    /* L9 Bessel-K underflow check: libm has no Bessel-K, so we can't probe directly.
     * Just note: libm does not implement K_nu(z). */

    /* L4 Boost docs warn about Y_nu at moderate-large z; check y0 at large z */
    printf("y0(1e6)    = %.17g\n", y0(1e6));
    printf("y0(1e8)    = %.17g\n", y0(1e8));

    return 0;
}
