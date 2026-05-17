// Probe Boost.Math cyl_bessel_j/y/i/k at cpp_bin_float<50> precision and double.
// Build:  g++ -std=c++17 -O2 boost-test-prog.cpp -o boost-test-prog
// Run:    ./boost-test-prog
#include <iostream>
#include <iomanip>
#include <complex>
#include <boost/multiprecision/cpp_bin_float.hpp>
#include <boost/math/special_functions/bessel.hpp>

int main() {
    using namespace boost::multiprecision;
    using Real50 = number<cpp_bin_float<50>>;

    // ----- cpp_bin_float<50> (silver tier, real arb-prec) -----
    Real50 x_2("2");
    Real50 x_15("1.5");
    Real50 x_3("3");
    Real50 x_10("10");
    Real50 nu_25("2.5");
    Real50 nu_05("0.5");
    Real50 nu_neg15("-1.5");

    std::cout << "=== Boost cpp_bin_float<50> ===" << std::endl;
    std::cout << std::setprecision(50);
    // NB Boost.Math spells Y_ν as `cyl_neumann` (the Neumann function); cyl_bessel_y does NOT exist.
    std::cout << "cyl_bessel_j(3, 2)       = " << boost::math::cyl_bessel_j(3, x_2) << std::endl;
    std::cout << "cyl_neumann (2.5, 1.5)   = " << boost::math::cyl_neumann(nu_25, x_15) << std::endl;
    std::cout << "cyl_bessel_i(0.5, 3)     = " << boost::math::cyl_bessel_i(nu_05, x_3) << std::endl;
    std::cout << "cyl_bessel_k(0, 10)      = " << boost::math::cyl_bessel_k(0, x_10) << std::endl;
    std::cout << "cyl_neumann (-1.5, 1.5)  = " << boost::math::cyl_neumann(nu_neg15, x_15) << std::endl;
    std::cout << "cyl_bessel_k(-1.5, 1.5)  = " << boost::math::cyl_bessel_k(nu_neg15, x_15) << std::endl;

    // J_0 at the first zero (L7 algorithm-divergence probe)
    Real50 z_root("2.4048255576957727686216318793264546431242449091460");
    std::cout << "cyl_bessel_j(0, 1st zero)= " << boost::math::cyl_bessel_j(0, z_root) << std::endl;

    // I_0(700), K_0(700)  (L9/L10 overflow / underflow probes)
    Real50 x_700("700");
    try {
        std::cout << "cyl_bessel_i(0, 700)     = " << boost::math::cyl_bessel_i(0, x_700) << std::endl;
    } catch (const std::exception &e) {
        std::cout << "cyl_bessel_i(0, 700)     THREW: " << e.what() << std::endl;
    }
    try {
        std::cout << "cyl_bessel_k(0, 700)     = " << boost::math::cyl_bessel_k(0, x_700) << std::endl;
    } catch (const std::exception &e) {
        std::cout << "cyl_bessel_k(0, 700)     THREW: " << e.what() << std::endl;
    }

    // ----- double (bronze tier) -----
    std::cout << std::endl << "=== Boost double ===" << std::endl;
    std::cout << std::setprecision(17);
    std::cout << "cyl_bessel_j(3, 2.0)     = " << boost::math::cyl_bessel_j(3.0, 2.0) << std::endl;
    std::cout << "cyl_neumann (2.5, 1.5)   = " << boost::math::cyl_neumann(2.5, 1.5) << std::endl;
    std::cout << "cyl_bessel_i(0.5, 3.0)   = " << boost::math::cyl_bessel_i(0.5, 3.0) << std::endl;
    std::cout << "cyl_bessel_k(0.0, 10.0)  = " << boost::math::cyl_bessel_k(0.0, 10.0) << std::endl;
    try {
        std::cout << "cyl_bessel_i(0.0, 700.0) = " << boost::math::cyl_bessel_i(0.0, 700.0) << std::endl;
    } catch (const std::exception &e) {
        std::cout << "cyl_bessel_i(0.0, 700.0) THREW: " << e.what() << std::endl;
    }

    // ----- complex: does Boost support cyl_bessel_j on std::complex? -----
    // (Erf R5 §2.4 confirmed Boost erf templates fail on std::complex; check Bessel similarly.)
    // Compile-only probe below in boost-complex-test-prog.cpp.

    return 0;
}
