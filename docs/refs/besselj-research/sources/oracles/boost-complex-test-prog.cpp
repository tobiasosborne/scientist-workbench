// Probe whether Boost.Math cyl_bessel_j instantiates on std::complex<double>.
// Build:  g++ -std=c++17 boost-complex-test-prog.cpp -o boost-complex-test-prog
// Expected: COMPILE FAILURE (per ADR-0040 Decision 8 + Erf R5 §2.4 mirror).
#include <iostream>
#include <complex>
#include <boost/math/special_functions/bessel.hpp>
int main() {
    std::complex<double> z(0.5, 0.7);
    auto r = boost::math::cyl_bessel_j(3.0, z);
    std::cout << r << std::endl;
    return 0;
}
